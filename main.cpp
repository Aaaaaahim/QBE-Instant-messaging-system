#ifndef NOMINMAX
#define NOMINMAX
#endif

#include "mongoose.h"
#include "sql.h"
#include "threadpool.h"

#include <atomic>
#include <cctype>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <sys/stat.h>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>

namespace {

struct PendingResponse {
  int status = 500;
  std::string content_type;
  std::string extra_headers;
  std::string body;
  bool send_body = true;
  unsigned long long content_length = 0;
};

struct FileInfo {
  unsigned long long size = 0;
  long long mtime = 0;
  bool exists = false;
};

static FileInfo get_file_info(const std::string& path) {
  FileInfo info;
#if defined(_WIN32)
  struct _stat64 st;
  if (_stat64(path.c_str(), &st) == 0) {
    info.size = (unsigned long long) st.st_size;
    info.mtime = (long long) st.st_mtime;
    info.exists = true;
  }
#else
  struct stat st;
  if (stat(path.c_str(), &st) == 0) {
    info.size = (unsigned long long) st.st_size;
    info.mtime = (long long) st.st_mtime;
    info.exists = true;
  }
#endif
  return info;
}

class StaticFileCache {
 public:
  StaticFileCache(size_t max_bytes, size_t max_file_bytes)
      : max_bytes_(max_bytes), max_file_bytes_(max_file_bytes) {}

  bool TryGet(const std::string& path, long long mtime, std::string* body_out, unsigned long long* size_out) {
    if (!body_out || !size_out) return false;
    std::lock_guard<std::mutex> guard(mu_);
    auto it = cache_.find(path);
    if (it == cache_.end()) return false;
    if (it->second.mtime != mtime) {
      total_bytes_ -= it->second.body.size();
      cache_.erase(it);
      return false;
    }
    *body_out = it->second.body;
    *size_out = it->second.size;
    return true;
  }

  void Put(const std::string& path, long long mtime, const std::string& body) {
    const size_t sz = body.size();
    if (sz == 0 || sz > max_file_bytes_ || sz > max_bytes_) return;
    std::lock_guard<std::mutex> guard(mu_);
    if (total_bytes_ + sz > max_bytes_) {
      cache_.clear();
      total_bytes_ = 0;
    }
    auto it = cache_.find(path);
    if (it != cache_.end()) {
      total_bytes_ -= it->second.body.size();
    }
    cache_[path] = Entry{body, (unsigned long long) sz, mtime};
    total_bytes_ += sz;
  }

 private:
  struct Entry {
    std::string body;
    unsigned long long size = 0;
    long long mtime = 0;
  };

  std::mutex mu_;
  std::unordered_map<std::string, Entry> cache_;
  size_t total_bytes_ = 0;
  const size_t max_bytes_;
  const size_t max_file_bytes_;
};

class SigintGuard {
 public:
  explicit SigintGuard(std::atomic_bool& running) : running_(running) {
    running_ptr_ = &running_;
    std::signal(SIGINT, &SigintGuard::on_sigint);
  }

  SigintGuard(const SigintGuard&) = delete;
  SigintGuard& operator=(const SigintGuard&) = delete;

 private:
  static void on_sigint(int) {
    if (running_ptr_ != nullptr) running_ptr_->store(false);
  }

 private:
  std::atomic_bool& running_;
  static std::atomic_bool* running_ptr_;
};

std::atomic_bool* SigintGuard::running_ptr_ = nullptr;

class HttpServerApp {
 public:
  HttpServerApp(std::string listen_url, std::string web_root, size_t worker_threads, SqlConfig sql_cfg)
      : listen_url_(std::move(listen_url)),
        web_root_(std::move(web_root)),
        pool_(ThreadPool::instance(worker_threads, kMaxQueueSize)),
        sql_(std::move(sql_cfg)) {
    mg_mgr_init(&mgr_);
    mg_wakeup_init(&mgr_);
  }

  HttpServerApp(const HttpServerApp&) = delete;
  HttpServerApp& operator=(const HttpServerApp&) = delete;

  ~HttpServerApp() {
    pool_.stop();
    mg_mgr_free(&mgr_);
  }

  int run() {
    SigintGuard sig(running_);
    (void) sig;

    pool_.start();

    mg_connection* lc = mg_http_listen(&mgr_, listen_url_.c_str(), &HttpServerApp::ev_handler, this);
    if (lc == nullptr) {
      std::cerr << "Listen failed: " << listen_url_ << ". Trying fallback ports..." << std::endl;
      const int base_port = 10022;
      const int max_tries = 8;
      for (int i = 1; i <= max_tries; ++i) {
        const int port = base_port + i;
        const std::string try_url = std::string("http://0.0.0.0:") + std::to_string(port);
        lc = mg_http_listen(&mgr_, try_url.c_str(), &HttpServerApp::ev_handler, this);
        if (lc != nullptr) {
          listen_url_ = try_url;
          std::cerr << "Listening on " << listen_url_ << std::endl;
          break;
        }
      }
      if (lc == nullptr) {
        std::cerr << "Listen failed: no available ports in range." << std::endl;
        running_ = false;
        return 1;
      }
    }

    while (running_) mg_mgr_poll(&mgr_, 50);
    pool_.stop();
    return 0;
  }

 private:
  static void ev_handler(mg_connection* c, int ev, void* ev_data) {
    auto* self = static_cast<HttpServerApp*>(c->fn_data);
    if (self) self->handle_event(c, ev, ev_data);
  }

  void handle_event(mg_connection* c, int ev, void* ev_data) {
    if (ev == MG_EV_CLOSE) {
      on_close(c);
      return;
    }
    if (ev == MG_EV_WAKEUP) {
      on_wakeup(c);
      (void) ev_data;
      return;
    }
    if (ev == MG_EV_HTTP_MSG) {
      on_http_msg(c, static_cast<mg_http_message*>(ev_data));
      return;
    }
  }

  void on_close(mg_connection* c) {
    std::lock_guard<std::mutex> guard(pending_mu_);
    closed_.insert(c->id);
    pending_.erase(c->id);
  }

  void on_wakeup(mg_connection* c) {
    std::unique_ptr<PendingResponse> resp;
    {
      std::lock_guard<std::mutex> guard(pending_mu_);
      auto it = pending_.find(c->id);
      if (it != pending_.end()) {
        resp = std::move(it->second);
        pending_.erase(it);
      }
    }
    if (!resp) return;

    const unsigned long long body_len = resp->content_length;
    const char* reason = http_reason(resp->status);
    const char* ct = resp->content_type.empty() ? "application/octet-stream" : resp->content_type.c_str();

    mg_printf(c,
              "HTTP/1.1 %d %s\r\n"
              "Content-Type: %s\r\n"
              "Content-Length: %llu\r\n"
              "Connection: close\r\n"
              "%s"
              "\r\n",
              resp->status,
              reason,
              ct,
              body_len,
              resp->extra_headers.c_str());
    if (resp->send_body && !resp->body.empty()) mg_send(c, resp->body.data(), resp->body.size());
    c->is_draining = 1;
  }

  void send_response_now(mg_connection* c, const PendingResponse& resp) {
    const unsigned long long body_len = resp.content_length;
    const char* reason = http_reason(resp.status);
    const char* ct = resp.content_type.empty() ? "application/octet-stream" : resp.content_type.c_str();

    mg_printf(c,
              "HTTP/1.1 %d %s\r\n"
              "Content-Type: %s\r\n"
              "Content-Length: %llu\r\n"
              "Connection: close\r\n"
              "%s"
              "\r\n",
              resp.status,
              reason,
              ct,
              body_len,
              resp.extra_headers.c_str());
    if (resp.send_body && !resp.body.empty()) mg_send(c, resp.body.data(), resp.body.size());
    c->is_draining = 1;
  }

  void on_http_msg(mg_connection* c, mg_http_message* hm) {
    if (!hm) {
      mg_http_reply(c, 400, "Connection: close\r\n", "Bad Request");
      c->is_draining = 1;
      return;
    }

    const std::string method(hm->method.buf, hm->method.len);
    const std::string uri(hm->uri.buf, hm->uri.len);
    const bool is_head = (method == "HEAD");

    // API requests go through thread pool to avoid blocking the event loop.
    if (uri.rfind("/api/", 0) == 0) {
      if (method != "POST") {
        mg_http_reply(c,
                      405,
                      "Content-Type: application/json; charset=utf-8\r\nConnection: close\r\n",
                      "%s",
                      "{\"ok\":false,\"error\":\"method_not_allowed\"}");
        c->is_draining = 1;
        return;
      }
      struct mg_str* ct = mg_http_get_header(hm, "Content-Type");
      const std::string cts = (ct == nullptr) ? std::string() : std::string(ct->buf, ct->len);
      if (!cts.empty() && cts.find("application/json") == std::string::npos) {
        mg_http_reply(c,
                      415,
                      "Content-Type: application/json; charset=utf-8\r\nConnection: close\r\n",
                      "%s",
                      "{\"ok\":false,\"error\":\"content_type_must_be_json\"}");
        c->is_draining = 1;
        return;
      }

      const std::string body(hm->body.buf, hm->body.len);
      const unsigned long conn_id = c->id;

      // Extract client IP/port for login update
      const uint32_t ip4 = c->rem.addr.ip4;
      char ip_buf[32] = {};
      std::snprintf(ip_buf, sizeof(ip_buf), "%u.%u.%u.%u",
                    (ip4) & 0xFF, (ip4 >> 8) & 0xFF,
                    (ip4 >> 16) & 0xFF, (ip4 >> 24) & 0xFF);
      const std::string client_ip(ip_buf);
      const unsigned int client_port = mg_ntohs(c->rem.port);

      if (!pool_.try_add_task([this, conn_id, uri, body, client_ip, client_port]() {
        auto resp = std::make_unique<PendingResponse>();
        resp->send_body = true;

        ApiResponse api;
        if (uri == "/api/login") api = ApiLogin(sql_, body, client_ip, client_port);
        else if (uri == "/api/register") api = ApiRegister(sql_, body);
        else if (uri == "/api/get_user") api = ApiGetUserByUid(sql_, body);
        else if (uri == "/api/add_friend") api = ApiAddFriend(sql_, body);
        else if (uri == "/api/friend_response") api = ApiFriendResponse(sql_, body);
        else if (uri == "/api/poll_events") api = ApiPollEvents(body);
        else if (uri == "/api/send_message") api = ApiSendMessage(sql_, body);
        else if (uri == "/api/create_group") api = ApiCreateGroup(sql_, body);
        else if (uri == "/api/send_group_message") api = ApiSendGroupMessage(sql_, body);
        else if (uri == "/api/upload") api = ApiUploadFile(body);
        else if (uri == "/api/upload_chunk") api = ApiUploadChunk(body);
        else if (uri == "/api/upload_cancel") api = ApiUploadCancel(body);
        else if (uri == "/api/rtc_config") api = ApiRtcConfig();
        else if (uri == "/api/rtc_offer") api = ApiRtcOffer(body);
        else if (uri == "/api/rtc_answer") api = ApiRtcAnswer(body);
        else if (uri == "/api/rtc_ice") api = ApiRtcIce(body);
        else if (uri == "/api/rtc_hangup") api = ApiRtcHangup(body);
        else if (uri == "/api/remove_friend") api = ApiRemoveFriend(body);
        else if (uri == "/api/update_status") api = ApiUpdateStatus(sql_, body);
        else api = {404, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"unknown_api\"}"};

        resp->status = api.status;
        resp->content_type = api.content_type;
        resp->body = api.body;
        resp->content_length = (unsigned long long) resp->body.size();
        post_response_and_wakeup(conn_id, std::move(resp));
      })) {
        mg_http_reply(c,
                      503,
                      "Content-Type: application/json; charset=utf-8\r\nConnection: close\r\n",
                      "%s",
                      "{\"ok\":false,\"error\":\"server_busy\"}");
        c->is_draining = 1;
      }
      return;
    }

    if (uri == "/") {
      mg_http_reply(c, 302, "Location: /web.html\r\nConnection: close\r\n", "");
      c->is_draining = 1;
      return;
    }
    if (uri == "/login") {
      mg_http_reply(c, 302, "Location: /login.html\r\nConnection: close\r\n", "");
      c->is_draining = 1;
      return;
    }

    if (!(method == "GET" || method == "HEAD")) {
      mg_http_reply(c, 405, "Content-Type: text/plain; charset=utf-8\r\nConnection: close\r\n", "Method Not Allowed");
      c->is_draining = 1;
      return;
    }
    if (!is_safe_uri_path(uri)) {
      mg_http_reply(c, 400, "Content-Type: text/plain; charset=utf-8\r\nConnection: close\r\n", "Bad Request");
      c->is_draining = 1;
      return;
    }

    std::string path = web_root_;
    path += uri;
    if (!path.empty() && path.back() == '/') path += "index.html";

    const FileInfo info = get_file_info(path);
    if (!info.exists) {
      mg_http_reply(c, 404, "Content-Type: text/plain; charset=utf-8\r\nConnection: close\r\n", "Not Found");
      c->is_draining = 1;
      return;
    }

    // If-Modified-Since (seconds precision) to reduce downloads.
    struct mg_str* ims_hdr = mg_http_get_header(hm, "If-Modified-Since");
    if (ims_hdr && info.mtime > 0) {
      const std::string ims(ims_hdr->buf, ims_hdr->len);
      const std::string lm = http_date((time_t) info.mtime);
      if (!lm.empty() && ims == lm) {
        PendingResponse resp;
        resp.status = 304;
        resp.content_type = guess_content_type(path);
        resp.send_body = false;
        resp.content_length = 0;
        resp.extra_headers = "Cache-Control: public, max-age=60\r\n";
        resp.extra_headers += "Last-Modified: ";
        resp.extra_headers += lm;
        resp.extra_headers += "\r\n";
        send_response_now(c, resp);
        return;
      }
    }

    // Small files are served inline to avoid queueing.
    if (is_head || info.size <= kInlineMaxBytes) {
      auto resp = build_static_response(path, info, is_head);
      send_response_now(c, *resp);
      return;
    }

    // Large files are served via thread pool to avoid blocking.
    const unsigned long conn_id = c->id;
    if (!pool_.try_add_task([this, conn_id, path, info, is_head]() {
      auto resp = build_static_response(path, info, is_head);
      post_response_and_wakeup(conn_id, std::move(resp));
    })) {
      mg_http_reply(c, 503, "Connection: close\r\n", "Service Unavailable");
      c->is_draining = 1;
    }
  }

  static std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char ch : s) {
      switch (ch) {
        case '\\': out += "\\\\"; break;
        case '"': out += "\\\""; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
          if ((unsigned char) ch < 0x20) {
            char buf[7];
            std::snprintf(buf, sizeof(buf), "\\u%04x", (unsigned) (unsigned char) ch);
            out += buf;
          } else {
            out += ch;
          }
      }
    }
    return out;
  }

  std::unique_ptr<PendingResponse> build_static_response(const std::string& path,
                                                         const FileInfo& info,
                                                         bool is_head) {
    auto resp = std::make_unique<PendingResponse>();
    resp->send_body = !is_head;

    resp->status = 200;
    resp->content_type = guess_content_type(path);
    resp->content_length = info.size;
    if (info.mtime > 0) {
      const std::string date = http_date((time_t) info.mtime);
      if (!date.empty()) {
        resp->extra_headers += "Last-Modified: ";
        resp->extra_headers += date;
        resp->extra_headers += "\r\n";
      }
    }
    resp->extra_headers += "Cache-Control: public, max-age=60\r\n";

    if (is_head) return resp;

    // Cache hit
    std::string cached_body;
    unsigned long long cached_len = 0;
    if (static_cache_.TryGet(path, info.mtime, &cached_body, &cached_len)) {
      resp->body = std::move(cached_body);
      resp->content_length = cached_len;
      return resp;
    }

    std::ifstream ifs(path, std::ios::binary);
    if (!ifs) {
      resp->status = 404;
      resp->content_type = "text/plain; charset=utf-8";
      resp->body = "Not Found";
      resp->content_length = (unsigned long long) resp->body.size();
      return resp;
    }

    resp->body.resize((size_t) info.size);
    if (info.size > 0) ifs.read(&resp->body[0], (std::streamsize) info.size);
    static_cache_.Put(path, info.mtime, resp->body);
    return resp;
  }

  void post_response_and_wakeup(unsigned long conn_id, std::unique_ptr<PendingResponse> resp) {
    if (!resp) return;
    PendingResponse* resp_raw = resp.get();

    {
      std::lock_guard<std::mutex> guard(pending_mu_);
      auto itc = closed_.find(conn_id);
      if (itc != closed_.end()) {
        closed_.erase(itc);
        return;
      }
      pending_[conn_id] = std::move(resp);
    }

    const char one = 1;
    if (!mg_wakeup(&mgr_, conn_id, &one, sizeof(one))) {
      std::lock_guard<std::mutex> guard(pending_mu_);
      auto it = pending_.find(conn_id);
      if (it != pending_.end() && it->second.get() == resp_raw) pending_.erase(it);
    }
  }

  static const char* http_reason(int status) {
    switch (status) {
      case 200: return "OK";
      case 302: return "Found";
      case 400: return "Bad Request";
      case 401: return "Unauthorized";
      case 403: return "Forbidden";
      case 404: return "Not Found";
      case 405: return "Method Not Allowed";
      case 503: return "Service Unavailable";
      default: return "Internal Server Error";
    }
  }

  static std::string http_date(time_t t) {
    char buf[64];
    std::tm tm_buf{};
#if defined(_WIN32)
    gmtime_s(&tm_buf, &t);
#else
    gmtime_r(&t, &tm_buf);
#endif
    if (std::strftime(buf, sizeof(buf), "%a, %d %b %Y %H:%M:%S GMT", &tm_buf) == 0) {
      return "";
    }
    return std::string(buf);
  }

  static std::string guess_content_type(const std::string& path) {
    auto dot = path.find_last_of('.');
    std::string ext = (dot == std::string::npos) ? std::string() : path.substr(dot + 1);
    for (auto& ch : ext) ch = (char) std::tolower((unsigned char) ch);

    if (ext == "html" || ext == "htm") return "text/html; charset=utf-8";
    if (ext == "css") return "text/css; charset=utf-8";
    if (ext == "js") return "application/javascript; charset=utf-8";
    if (ext == "json") return "application/json; charset=utf-8";
    if (ext == "txt") return "text/plain; charset=utf-8";
    if (ext == "jpg" || ext == "jpeg") return "image/jpeg";
    if (ext == "png") return "image/png";
    if (ext == "gif") return "image/gif";
    if (ext == "svg") return "image/svg+xml";
    if (ext == "ico") return "image/x-icon";
    return "application/octet-stream";
  }

  static bool is_safe_uri_path(const std::string& uri_path) {
    if (uri_path.empty() || uri_path[0] != '/') return false;
    if (uri_path.find("..") != std::string::npos) return false;
    if (uri_path.find('\\') != std::string::npos) return false;
    if (uri_path.find('\0') != std::string::npos) return false;
    return true;
  }

 private:
  mg_mgr mgr_{};
  std::string listen_url_;
  std::string web_root_;
  ThreadPool& pool_;
  SqlService sql_;
  std::atomic_bool running_{true};

  // Static file cache (reduce disk IO)
  StaticFileCache static_cache_{64 * 1024 * 1024, 2 * 1024 * 1024};

  std::mutex pending_mu_;
  std::unordered_map<unsigned long, std::unique_ptr<PendingResponse>> pending_;
  std::unordered_set<unsigned long> closed_;

  static const size_t kInlineMaxBytes = 128 * 1024;
  static const size_t kMaxQueueSize = 2048;
};

static const char* kListenUrl = "http://127.0.0.1:10022";

}  // namespace

int main() {
  const unsigned int hc = std::thread::hardware_concurrency();
  const size_t worker_threads = (hc > 1) ? (size_t) (hc - 1) : (size_t) 1;

  SqlConfig sql_cfg;
#if defined(USE_MYSQL)
  sql_cfg.backend = SqlConfig::Backend::MySQL;
  sql_cfg.host = "127.0.0.1";
  sql_cfg.port = 3306;

  sql_cfg.user = (std::getenv("QBE_DB_USER") ? std::getenv("QBE_DB_USER") : "hidden_user");
  sql_cfg.backend = SqlConfig::Backend::File;
  sql_cfg.file_path = "user_db.tsv";
#endif

  HttpServerApp app(kListenUrl, "web_root", worker_threads, sql_cfg);
  return app.run();
}


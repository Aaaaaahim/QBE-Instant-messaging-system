#pragma once

#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <unordered_map>

struct ApiResponse {
  int status = 500;
  std::string content_type = "application/json; charset=utf-8";
  std::string body;
};

struct SqlConfig {
  enum class Backend { File, MySQL };
  Backend backend = Backend::File;

  // File backend
  std::string file_path;

  // MySQL backend
  std::string host = "127.0.0.1";
  unsigned int port = 3306;
  std::string user;
  std::string password;
  std::string database;
  std::string table = "client_verify";
};

class SqlService {
 public:
  explicit SqlService(SqlConfig cfg);
  explicit SqlService(std::string db_file_path);

  SqlService(const SqlService&) = delete;
  SqlService& operator=(const SqlService&) = delete;

  bool RegisterUser(const std::string& email,
                    const std::string& name,
                    const std::string& password,
                    std::string* err = nullptr);

  bool VerifyLogin(const std::string& email,
                   const std::string& password,
                   unsigned long long* out_uid,
                   std::string* out_name,
                   std::string* err = nullptr) const;

  bool GetUser(const std::string& email,
               unsigned long long* out_uid,
               std::string* out_name) const;

  bool UpdateUserIpPort(const std::string& email,
                        const std::string& ip,
                        unsigned int port);

  bool GetUserByUid(unsigned long long uid,
                    std::string* out_name,
                    std::string* out_ip,
                    unsigned int* out_port,
                    std::string* out_status) const;

  bool UpdateUserStatus(unsigned long long uid, const std::string& status);

 private:
  struct UserRow {
    std::string pass_hash;
    std::string salt;
    unsigned long long uid = 0;
    std::string email;
    std::string name;
    std::int64_t created_ms = 0;
    std::string ip;
    unsigned int port = 0;
    std::string status;
  };

  static bool IsValidEmail(const std::string& s);
  static bool IsValidPassword(const std::string& s);
  static std::string Trim(const std::string& s);
  static std::string RandomSaltHex(size_t bytes);
  static std::string HashPasswordHex(const std::string& salt_hex, const std::string& password);

  bool LoadLocked() const;
  bool SaveLocked() const;

#if defined(USE_MYSQL)
  bool MySqlRegisterUser(const std::string& email,
                         const std::string& name,
                         const std::string& password,
                         std::string* err);
  bool MySqlVerifyLogin(const std::string& email,
                        const std::string& password,
                        unsigned long long* out_uid,
                        std::string* out_name,
                        std::string* err) const;
  bool MySqlGetUser(const std::string& email,
                    unsigned long long* out_uid,
                    std::string* out_name) const;
#endif

 private:
  SqlConfig cfg_;
  mutable std::mutex mu_;
  mutable bool loaded_ = false;
  mutable std::unordered_map<std::string, UserRow> users_;
  mutable std::unordered_map<unsigned long long, std::string> users_by_uid_;
  mutable unsigned long long next_uid_ = 1;
};

// ---------------------------------------------------------------------------
// Event queue: in-memory buffer keyed by uid; clients drain via poll_events.
// RTC signaling events use a short TTL (15 s); others survive 2 min.
// ---------------------------------------------------------------------------

static const std::int64_t kRtcEventTtlMs     = 15000LL;
static const std::int64_t kDefaultEventTtlMs = 120000LL;

struct PendingEvent {
  std::string  json;        // raw JSON object string
  std::int64_t enqueue_ms;  // epoch-ms at enqueue time
};

class EventQueue {
 public:
  void Push(unsigned long long uid, const std::string& json_event);
  void PushUnique(unsigned long long uid, const std::string& json_event);
  // Drain all live (non-expired) events; returns JSON array string.
  std::string Drain(unsigned long long uid);

 private:
  static std::int64_t ttl_for(const std::string& json);

  mutable std::mutex mu_;
  std::unordered_map<unsigned long long, std::deque<PendingEvent>> q_;
};

EventQueue& GetEventQueue();

ApiResponse ApiRegister(SqlService& svc, const std::string& json_body);
ApiResponse ApiLogin(SqlService& svc, const std::string& json_body, const std::string& client_ip, unsigned int client_port);
ApiResponse ApiGetUserByUid(const SqlService& svc, const std::string& json_body);
ApiResponse ApiAddFriend(const SqlService& svc, const std::string& json_body);
ApiResponse ApiFriendResponse(const SqlService& svc, const std::string& json_body);
ApiResponse ApiRemoveFriend(const std::string& json_body);
ApiResponse ApiPollEvents(const std::string& json_body);
ApiResponse ApiUpdateStatus(SqlService& svc, const std::string& json_body);
ApiResponse ApiSendMessage(const SqlService& svc, const std::string& json_body);
ApiResponse ApiCreateGroup(const SqlService& svc, const std::string& json_body);
ApiResponse ApiSendGroupMessage(const SqlService& svc, const std::string& json_body);
ApiResponse ApiUploadFile(const std::string& json_body);
ApiResponse ApiUploadChunk(const std::string& json_body);
ApiResponse ApiUploadCancel(const std::string& json_body);
ApiResponse ApiRtcOffer(const std::string& json_body);
ApiResponse ApiRtcAnswer(const std::string& json_body);
ApiResponse ApiRtcIce(const std::string& json_body);
// reason: "rejected" (callee declined) or "ended" (normal hangup)
ApiResponse ApiRtcHangup(const std::string& json_body);
ApiResponse ApiRtcConfig();

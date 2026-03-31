#include "sql.h"

#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sys/stat.h>
#if defined(_WIN32)
#include <direct.h>
#endif
#include <fstream>
#include <mutex>
#include <random>
#include <sstream>

#include "mongoose.h"  // mg_json_get_str, mg_free

#if defined(USE_MYSQL)
// MySQL C API
// VS: add include path that contains mysql.h, and link libmysql.lib.
// Also make sure libmysql.dll is available next to the exe at runtime.
#include <mysql.h>

#ifdef _MSC_VER
#pragma comment(lib, "libmysql.lib")
#endif
#endif

namespace {

static std::int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

static std::string to_hex_u8(const unsigned char* data, size_t n) {
  static const char* kHex = "0123456789abcdef";
  std::string out;
  out.resize(n * 2);
  for (size_t i = 0; i < n; ++i) {
    out[i * 2 + 0] = kHex[(data[i] >> 4) & 0xF];
    out[i * 2 + 1] = kHex[data[i] & 0xF];
  }
  return out;
}

static bool constant_time_equal(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  unsigned char diff = 0;
  for (size_t i = 0; i < a.size(); ++i) diff |= (unsigned char) (a[i] ^ b[i]);
  return diff == 0;
}

// Simple, dependency-free hash (FNV-1a 64-bit) for demo purposes.
// NOTE: This is NOT a password hashing algorithm. For production use a
// proper KDF (bcrypt/scrypt/Argon2) and a real database.
static std::uint64_t fnv1a_64(const void* data, size_t len) {
  const unsigned char* p = static_cast<const unsigned char*>(data);
  std::uint64_t h = 1469598103934665603ULL;
  for (size_t i = 0; i < len; ++i) {
    h ^= (std::uint64_t) p[i];
    h *= 1099511628211ULL;
  }
  return h;
}

static std::string u64_hex(std::uint64_t v) {
  static const char* kHex = "0123456789abcdef";
  std::string out(16, '0');
  for (int i = 15; i >= 0; --i) {
    out[(size_t) i] = kHex[v & 0xF];
    v >>= 4;
  }
  return out;
}

}  // namespace

#if defined(USE_MYSQL)
namespace {

static void mysql_init_once() {
  static std::once_flag once;
  std::call_once(once, []() {
    // Safe to call even if unused; returns 0 on success.
    (void) ::mysql_library_init(0, nullptr, nullptr);
  });
}

static bool mysql_stmt_exec(MYSQL_STMT* stmt, std::string* err) {
  if (stmt == nullptr) {
    if (err) *err = "stmt null";
    return false;
  }
  if (::mysql_stmt_execute(stmt) != 0) {
    if (err) *err = ::mysql_stmt_error(stmt);
    return false;
  }
  return true;
}

}  // namespace
#endif

SqlService::SqlService(SqlConfig cfg) : cfg_(std::move(cfg)) {
  if (cfg_.backend == SqlConfig::Backend::File && cfg_.file_path.empty()) {
    cfg_.file_path = "user_db.tsv";
  }
}

SqlService::SqlService(std::string db_file_path) {
  SqlConfig cfg;
  cfg.backend = SqlConfig::Backend::File;
  cfg.file_path = std::move(db_file_path);
  cfg_ = std::move(cfg);
}

namespace {

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
        if ((unsigned char) ch >= 0x20) out.push_back(ch);
        break;
    }
  }
  return out;
}

static std::string json_get_field(const std::string& body, const char* field) {
  struct mg_str js{(char*) body.c_str(), body.size()};
  std::string path = "$.";
  path += field;
  char* v = mg_json_get_str(js, path.c_str());
  if (v != nullptr) {
    std::string out(v);
    mg_free(v);
    return out;
  }
  // Fallback: if JSON value is a number (not a string), read as numeric
  double num = 0;
  if (mg_json_get_num(js, path.c_str(), &num)) {
    long long n = (long long) num;
    return std::to_string(n);
  }
  return {};
}

static std::string lower_ascii(const std::string& s) {
  std::string out = s;
  for (char& ch : out) {
    if (ch >= 'A' && ch <= 'Z') ch = (char) (ch - 'A' + 'a');
  }
  return out;
}

static bool ends_with(const std::string& s, const std::string& suffix) {
  if (s.size() < suffix.size()) return false;
  return s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

static bool is_allowed_upload_name(const std::string& name) {
  const std::string n = lower_ascii(name);
  return ends_with(n, ".zip") || ends_with(n, ".rar") ||
         ends_with(n, ".png") || ends_with(n, ".jpg") || ends_with(n, ".jpeg") ||
         ends_with(n, ".gif") || ends_with(n, ".webp") ||
         ends_with(n, ".mp4") || ends_with(n, ".webm") || ends_with(n, ".ogg") ||
         ends_with(n, ".mov");
}

static std::vector<unsigned long long> json_get_uid_list(const std::string& body, const char* field) {
  struct mg_str js{(char*) body.c_str(), body.size()};
  std::string path = "$.";
  path += field;
  std::vector<unsigned long long> out;

  int idx = 0;
  while (true) {
    std::string ipath = path + "[" + std::to_string(idx) + "]";
    double num = 0;
    if (mg_json_get_num(js, ipath.c_str(), &num)) {
      const unsigned long long uid = (unsigned long long) num;
      if (uid) out.push_back(uid);
      idx += 1;
      continue;
    }
    char* s = mg_json_get_str(js, ipath.c_str());
    if (s != nullptr) {
      const unsigned long long uid = std::strtoull(s, nullptr, 10);
      if (uid) out.push_back(uid);
      mg_free(s);
      idx += 1;
      continue;
    }
    break;
  }
  return out;
}

}  // namespace

std::string SqlService::Trim(const std::string& s) {
  size_t b = 0;
  while (b < s.size() && std::isspace((unsigned char) s[b])) ++b;
  size_t e = s.size();
  while (e > b && std::isspace((unsigned char) s[e - 1])) --e;
  return s.substr(b, e - b);
}

bool SqlService::IsValidEmail(const std::string& s) {
  // Lightweight email check for UI + server consistency.
  if (s.empty() || s.size() > 128) return false;
  const auto at = s.find('@');
  if (at == std::string::npos || at == 0 || at + 1 >= s.size()) return false;
  if (s.find('@', at + 1) != std::string::npos) return false;
  const auto dot = s.find('.', at + 1);
  if (dot == std::string::npos || dot + 1 >= s.size()) return false;
  if (s.find(' ') != std::string::npos) return false;
  return true;
}

bool SqlService::IsValidPassword(const std::string& s) {
  if (s.size() < 6 || s.size() > 16) return false;
  for (char ch : s) {
    const unsigned char c = (unsigned char) ch;
    if (!(std::isalnum(c))) return false;
  }
  return true;
}

std::string SqlService::RandomSaltHex(size_t bytes) {
  std::random_device rd;
  std::mt19937_64 gen(rd());
  std::uniform_int_distribution<unsigned int> dist(0, 255);
  std::string raw;
  raw.resize(bytes);
  for (size_t i = 0; i < bytes; ++i) raw[i] = (char) dist(gen);
  return to_hex_u8((const unsigned char*) raw.data(), raw.size());
}

std::string SqlService::HashPasswordHex(const std::string& salt_hex, const std::string& password) {
  // Mix salt + password into a small demo hash.
  std::string material;
  material.reserve(salt_hex.size() + 1 + password.size());
  material.append(salt_hex);
  material.push_back(':');
  material.append(password);
  const std::uint64_t h = fnv1a_64(material.data(), material.size());
  return u64_hex(h);
}

bool SqlService::LoadLocked() const {
  if (loaded_) return true;
  // Rebuild cache: email map, uid index, next uid.
  users_.clear();
  users_by_uid_.clear();
  next_uid_ = 1;

  std::ifstream ifs(cfg_.file_path, std::ios::in | std::ios::binary);
  if (!ifs) {
    loaded_ = true;  // treat missing file as empty DB
    return true;
  }

  std::string line;
  unsigned long long max_uid = 0;
  while (std::getline(ifs, line)) {
    line = Trim(line);
    if (line.empty()) continue;
    if (!line.empty() && line[0] == '#') continue;

    // Format: uid\temail\tname\tpass_hash_hex\tsalt_hex\tcreated_ms\tip\tport\tstatus
    std::string uid_s, email, name, pass_hash, salt, created, ip, port_s, status;
    std::istringstream iss(line);
    if (!std::getline(iss, uid_s, '\t')) continue;
    if (!std::getline(iss, email, '\t')) continue;
    if (!std::getline(iss, name, '\t')) name.clear();
    if (!std::getline(iss, pass_hash, '\t')) continue;
    if (!std::getline(iss, salt, '\t')) continue;
    if (!std::getline(iss, created, '\t')) created.clear();
    if (!std::getline(iss, ip, '\t')) ip.clear();
    if (!std::getline(iss, port_s, '\t')) port_s.clear();
    if (!std::getline(iss, status, '\t')) status.clear();

    UserRow row;
    row.uid = (unsigned long long) std::strtoull(Trim(uid_s).c_str(), nullptr, 10);
    row.pass_hash = Trim(pass_hash);
    row.salt = Trim(salt);
    row.email = Trim(email);
    row.name = Trim(name);
    row.created_ms = 0;
    if (!created.empty()) row.created_ms = std::strtoll(created.c_str(), nullptr, 10);
    row.ip = Trim(ip);
    row.port = port_s.empty() ? 0 : (unsigned int) std::strtoul(Trim(port_s).c_str(), nullptr, 10);
    row.status = Trim(status);
    if (!IsValidEmail(row.email)) continue;
    max_uid = (row.uid > max_uid) ? row.uid : max_uid;
    users_[row.email] = row;
    users_by_uid_[row.uid] = row.email;
  }

  next_uid_ = max_uid + 1;

  loaded_ = true;
  return true;
}

bool SqlService::SaveLocked() const {
  // Write to a temp file then rename to reduce risk of corruption.
  const std::string tmp = cfg_.file_path + ".tmp";
  {
    std::ofstream ofs(tmp, std::ios::out | std::ios::binary | std::ios::trunc);
    if (!ofs) return false;
    ofs << "# uid\temail\tname\tpass_hash_hex\tsalt_hex\tcreated_ms\tip\tport\tstatus\n";
    for (const auto& kv : users_) {
      const auto& r = kv.second;
      ofs << r.uid << "\t" << r.email << "\t" << r.name << "\t" << r.pass_hash << "\t" << r.salt << "\t" << r.created_ms << "\t" << r.ip << "\t" << r.port << "\t" << r.status << "\n";
    }
  }
  std::remove(cfg_.file_path.c_str());
  return std::rename(tmp.c_str(), cfg_.file_path.c_str()) == 0;
}

bool SqlService::RegisterUser(const std::string& email_in,
                              const std::string& name_in,
                              const std::string& password_in,
                              std::string* err) {
  if (cfg_.backend == SqlConfig::Backend::MySQL) {
#if defined(USE_MYSQL)
    return MySqlRegisterUser(email_in, name_in, password_in, err);
#else
    if (err) *err = "mysql backend not compiled (USE_MYSQL)";
    return false;
#endif
  }
  const std::string email = Trim(email_in);
  const std::string name = Trim(name_in);
  const std::string password = password_in;

  if (!IsValidEmail(email)) {
    if (err) *err = "invalid email";
    return false;
  }
  if (name.empty() || name.size() > 64) {
    if (err) *err = "invalid name";
    return false;
  }
  if (!IsValidPassword(password)) {
    if (err) *err = "invalid password";
    return false;
  }

  std::lock_guard<std::mutex> lock(mu_);
  if (!LoadLocked()) {
    if (err) *err = "db load failed";
    return false;
  }
  if (users_.find(email) != users_.end()) {
    if (err) *err = "email already exists";
    return false;
  }

  UserRow row;
  // Allocate uid (LoadLocked maintains next_uid_).
  row.uid = next_uid_;
  row.email = email;
  row.name = name;
  row.salt = RandomSaltHex(16);
  row.pass_hash = HashPasswordHex(row.salt, password);
  row.created_ms = now_ms();
  users_[email] = std::move(row);
  users_by_uid_[users_[email].uid] = email;
  next_uid_ = users_[email].uid + 1;

  if (!SaveLocked()) {
    const auto uid = users_[email].uid;
    users_.erase(email);
    users_by_uid_.erase(uid);
    if (err) *err = "db save failed";
    return false;
  }
  return true;
}

bool SqlService::VerifyLogin(const std::string& email_in,
                             const std::string& password_in,
                             unsigned long long* out_uid,
                             std::string* out_name,
                             std::string* err) const {
  if (cfg_.backend == SqlConfig::Backend::MySQL) {
#ifdef USE_MYSQL
    return MySqlVerifyLogin(email_in, password_in, out_uid, out_name, err);
#else
    if (err) *err = "mysql backend not compiled (USE_MYSQL)";
    return false;
#endif
  }
  if (out_uid) *out_uid = 0;
  if (out_name) out_name->clear();
  const std::string email = Trim(email_in);
  const std::string password = password_in;

  if (!IsValidEmail(email)) {
    if (err) *err = "invalid email";
    return false;
  }
  if (!IsValidPassword(password)) {
    if (err) *err = "invalid password";
    return false;
  }

  std::lock_guard<std::mutex> lock(mu_);
  if (!LoadLocked()) {
    if (err) *err = "db load failed";
    return false;
  }

  auto it = users_.find(email);
  if (it == users_.end()) {
    if (err) *err = "user not found";
    return false;
  }
  const UserRow& row = it->second;
  const std::string calc = HashPasswordHex(row.salt, password);
  if (!constant_time_equal(calc, row.pass_hash)) {
    if (err) *err = "wrong password";
    return false;
  }
  if (out_uid) *out_uid = row.uid;
  if (out_name) *out_name = row.name;
  return true;
}

bool SqlService::GetUser(const std::string& email_in,
                         unsigned long long* out_uid,
                         std::string* out_name) const {
  if (cfg_.backend == SqlConfig::Backend::MySQL) {
#ifdef USE_MYSQL
    return MySqlGetUser(email_in, out_uid, out_name);
#else
    return false;
#endif
  }
  if (out_uid) *out_uid = 0;
  if (out_name) out_name->clear();
  const std::string email = Trim(email_in);
  if (!IsValidEmail(email)) return false;

  std::lock_guard<std::mutex> lock(mu_);
  if (!LoadLocked()) return false;
  auto it = users_.find(email);
  if (it == users_.end()) return false;
  if (out_uid) *out_uid = it->second.uid;
  if (out_name) *out_name = it->second.name;
  return true;
}

#ifdef USE_MYSQL

bool SqlService::MySqlRegisterUser(const std::string& email_in,
                                   const std::string& name_in,
                                   const std::string& password_in,
                                   std::string* err) {
  mysql_init_once();

  const std::string email = Trim(email_in);
  const std::string name = Trim(name_in);
  const std::string password = password_in;

  // Match DB column sizes to avoid truncation surprises.
  if (!IsValidEmail(email) || email.size() > 20) {
    if (err) *err = "invalid email";
    return false;
  }
  if (name.empty() || name.size() > 20) {
    if (err) *err = "invalid name";
    return false;
  }
  if (!IsValidPassword(password) || password.size() > 20) {
    if (err) *err = "invalid password";
    return false;
  }

  MYSQL* conn = ::mysql_init(nullptr);
  if (!conn) {
    if (err) *err = "mysql_init failed";
    return false;
  }

  // Force utf8 (table is utf8 in your schema)
  (void) ::mysql_options(conn, MYSQL_SET_CHARSET_NAME, "utf8");

  if (!::mysql_real_connect(conn,
                            cfg_.host.c_str(),
                            cfg_.user.c_str(),
                            cfg_.password.c_str(),
                            cfg_.database.c_str(),
                            cfg_.port,
                            nullptr,
                            0)) {
    if (err) *err = ::mysql_error(conn);
    ::mysql_close(conn);
    return false;
  }

  // Pre-check email exists (recommended to also enforce UNIQUE(email) in DB).
  {
    const std::string q = "SELECT uid FROM " + cfg_.table + " WHERE email= LIMIT 1";
    MYSQL_STMT* st = ::mysql_stmt_init(conn);
    if (!st) {
      if (err) *err = "stmt init failed";
      ::mysql_close(conn);
      return false;
    }
    if (::mysql_stmt_prepare(st, q.c_str(), (unsigned long) q.size()) != 0) {
      if (err) *err = ::mysql_stmt_error(st);
      ::mysql_stmt_close(st);
      ::mysql_close(conn);
      return false;
    }
    MYSQL_BIND b[1]{};
    unsigned long email_len = (unsigned long) email.size();
    b[0].buffer_type = MYSQL_TYPE_STRING;
    b[0].buffer = (void*) email.data();
    b[0].buffer_length = email_len;
    b[0].length = &email_len;
    if (::mysql_stmt_bind_param(st, b) != 0) {
      if (err) *err = ::mysql_stmt_error(st);
      ::mysql_stmt_close(st);
      ::mysql_close(conn);
      return false;
    }
    if (::mysql_stmt_execute(st) != 0) {
      if (err) *err = ::mysql_stmt_error(st);
      ::mysql_stmt_close(st);
      ::mysql_close(conn);
      return false;
    }
    int uid = 0;
    MYSQL_BIND out[1]{};
    out[0].buffer_type = MYSQL_TYPE_LONG;
    out[0].buffer = &uid;
    if (::mysql_stmt_bind_result(st, out) != 0) {
      if (err) *err = ::mysql_stmt_error(st);
      ::mysql_stmt_close(st);
      ::mysql_close(conn);
      return false;
    }
    (void) ::mysql_stmt_store_result(st);
    const int fetch_rc = ::mysql_stmt_fetch(st);
    ::mysql_stmt_close(st);
    if (fetch_rc == 0) {
      if (err) *err = "email already exists";
      ::mysql_close(conn);
      return false;
    }
  }

  // Insert
  {
    const std::string q = "INSERT INTO " + cfg_.table + " (uname,pwd,email) VALUES (,,)";
    MYSQL_STMT* st = ::mysql_stmt_init(conn);
    if (!st) {
      if (err) *err = "stmt init failed";
      ::mysql_close(conn);
      return false;
    }
    if (::mysql_stmt_prepare(st, q.c_str(), (unsigned long) q.size()) != 0) {
      if (err) *err = ::mysql_stmt_error(st);
      ::mysql_stmt_close(st);
      ::mysql_close(conn);
      return false;
    }
    MYSQL_BIND b[3]{};
    unsigned long uname_len = (unsigned long) name.size();
    unsigned long pwd_len = (unsigned long) password.size();
    unsigned long email_len = (unsigned long) email.size();
    b[0].buffer_type = MYSQL_TYPE_STRING;
    b[0].buffer = (void*) name.data();
    b[0].buffer_length = uname_len;
    b[0].length = &uname_len;

    b[1].buffer_type = MYSQL_TYPE_STRING;
    b[1].buffer = (void*) password.data();
    b[1].buffer_length = pwd_len;
    b[1].length = &pwd_len;

    b[2].buffer_type = MYSQL_TYPE_STRING;
    b[2].buffer = (void*) email.data();
    b[2].buffer_length = email_len;
    b[2].length = &email_len;

    if (::mysql_stmt_bind_param(st, b) != 0) {
      if (err) *err = ::mysql_stmt_error(st);
      ::mysql_stmt_close(st);
      ::mysql_close(conn);
      return false;
    }
    if (!mysql_stmt_exec(st, err)) {
      ::mysql_stmt_close(st);
      ::mysql_close(conn);
      return false;
    }
    ::mysql_stmt_close(st);
  }

  ::mysql_close(conn);
  return true;
}

bool SqlService::MySqlVerifyLogin(const std::string& email_in,
                                  const std::string& password_in,
                                  unsigned long long* out_uid,
                                  std::string* out_name,
                                  std::string* err) const {
  mysql_init_once();
  if (out_uid) *out_uid = 0;
  if (out_name) out_name->clear();

  const std::string email = Trim(email_in);
  const std::string password = password_in;
  if (!IsValidEmail(email) || email.size() > 20) {
    if (err) *err = "invalid email";
    return false;
  }
  if (!IsValidPassword(password) || password.size() > 20) {
    if (err) *err = "invalid password";
    return false;
  }

  MYSQL* conn = ::mysql_init(nullptr);
  if (!conn) {
    if (err) *err = "mysql_init failed";
    return false;
  }
  (void) ::mysql_options(conn, MYSQL_SET_CHARSET_NAME, "utf8");
  if (!::mysql_real_connect(conn,
                            cfg_.host.c_str(),
                            cfg_.user.c_str(),
                            cfg_.password.c_str(),
                            cfg_.database.c_str(),
                            cfg_.port,
                            nullptr,
                            0)) {
    if (err) *err = ::mysql_error(conn);
    ::mysql_close(conn);
    return false;
  }

  const std::string q = "SELECT uid, uname, pwd FROM " + cfg_.table + " WHERE email= LIMIT 1";
  MYSQL_STMT* st = ::mysql_stmt_init(conn);
  if (!st) {
    if (err) *err = "stmt init failed";
    ::mysql_close(conn);
    return false;
  }
  if (::mysql_stmt_prepare(st, q.c_str(), (unsigned long) q.size()) != 0) {
    if (err) *err = ::mysql_stmt_error(st);
    ::mysql_stmt_close(st);
    ::mysql_close(conn);
    return false;
  }

  MYSQL_BIND in[1]{};
  unsigned long email_len = (unsigned long) email.size();
  in[0].buffer_type = MYSQL_TYPE_STRING;
  in[0].buffer = (void*) email.data();
  in[0].buffer_length = email_len;
  in[0].length = &email_len;
  if (::mysql_stmt_bind_param(st, in) != 0) {
    if (err) *err = ::mysql_stmt_error(st);
    ::mysql_stmt_close(st);
    ::mysql_close(conn);
    return false;
  }
  if (::mysql_stmt_execute(st) != 0) {
    if (err) *err = ::mysql_stmt_error(st);
    ::mysql_stmt_close(st);
    ::mysql_close(conn);
    return false;
  }

  unsigned long long uid = 0;
  char uname_buf[64]{};
  unsigned long uname_len = 0;
  char pwd_buf[64]{};
  unsigned long pwd_len = 0;

  MYSQL_BIND out[3]{};
  out[0].buffer_type = MYSQL_TYPE_LONGLONG;
  out[0].buffer = &uid;
  out[1].buffer_type = MYSQL_TYPE_STRING;
  out[1].buffer = uname_buf;
  out[1].buffer_length = sizeof(uname_buf);
  out[1].length = &uname_len;
  out[2].buffer_type = MYSQL_TYPE_STRING;
  out[2].buffer = pwd_buf;
  out[2].buffer_length = sizeof(pwd_buf);
  out[2].length = &pwd_len;

  if (::mysql_stmt_bind_result(st, out) != 0) {
    if (err) *err = ::mysql_stmt_error(st);
    ::mysql_stmt_close(st);
    ::mysql_close(conn);
    return false;
  }
  (void) ::mysql_stmt_store_result(st);
  const int fetch_rc = ::mysql_stmt_fetch(st);
  ::mysql_stmt_close(st);
  ::mysql_close(conn);

  if (fetch_rc != 0) {
    if (err) *err = "user not found";
    return false;
  }
  const std::string db_pwd(pwd_buf, pwd_len);
  if (db_pwd != password) {
    if (err) *err = "wrong password";
    return false;
  }

  if (out_uid) *out_uid = uid;
  if (out_name) *out_name = std::string(uname_buf, uname_len);
  return true;
}

bool SqlService::MySqlGetUser(const std::string& email_in,
                              unsigned long long* out_uid,
                              std::string* out_name) const {
  mysql_init_once();
  if (out_uid) *out_uid = 0;
  if (out_name) out_name->clear();

  const std::string email = Trim(email_in);
  if (!IsValidEmail(email) || email.size() > 20) return false;

  MYSQL* conn = ::mysql_init(nullptr);
  if (!conn) return false;
  (void) ::mysql_options(conn, MYSQL_SET_CHARSET_NAME, "utf8");
  if (!::mysql_real_connect(conn,
                            cfg_.host.c_str(),
                            cfg_.user.c_str(),
                            cfg_.password.c_str(),
                            cfg_.database.c_str(),
                            cfg_.port,
                            nullptr,
                            0)) {
    ::mysql_close(conn);
    return false;
  }

  const std::string q = "SELECT uid, uname FROM " + cfg_.table + " WHERE email= LIMIT 1";
  MYSQL_STMT* st = ::mysql_stmt_init(conn);
  if (!st) {
    ::mysql_close(conn);
    return false;
  }
  if (::mysql_stmt_prepare(st, q.c_str(), (unsigned long) q.size()) != 0) {
    ::mysql_stmt_close(st);
    ::mysql_close(conn);
    return false;
  }

  MYSQL_BIND in[1]{};
  unsigned long email_len = (unsigned long) email.size();
  in[0].buffer_type = MYSQL_TYPE_STRING;
  in[0].buffer = (void*) email.data();
  in[0].buffer_length = email_len;
  in[0].length = &email_len;
  if (::mysql_stmt_bind_param(st, in) != 0 || ::mysql_stmt_execute(st) != 0) {
    ::mysql_stmt_close(st);
    ::mysql_close(conn);
    return false;
  }

  unsigned long long uid = 0;
  char uname_buf[64]{};
  unsigned long uname_len = 0;
  MYSQL_BIND out[2]{};
  out[0].buffer_type = MYSQL_TYPE_LONGLONG;
  out[0].buffer = &uid;
  out[1].buffer_type = MYSQL_TYPE_STRING;
  out[1].buffer = uname_buf;
  out[1].buffer_length = sizeof(uname_buf);
  out[1].length = &uname_len;
  if (::mysql_stmt_bind_result(st, out) != 0) {
    ::mysql_stmt_close(st);
    ::mysql_close(conn);
    return false;
  }
  (void) ::mysql_stmt_store_result(st);
  const int fetch_rc = ::mysql_stmt_fetch(st);
  ::mysql_stmt_close(st);
  ::mysql_close(conn);
  if (fetch_rc != 0) return false;
  if (out_uid) *out_uid = uid;
  if (out_name) *out_name = std::string(uname_buf, uname_len);
  return true;
}

#endif  // defined(USE_MYSQL)

ApiResponse ApiGetUserByUid(const SqlService& svc, const std::string& json_body) {
  ApiResponse r;
  const std::string uid_s = json_get_field(json_body, "uid");
  if (uid_s.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"missing uid\"}";
    return r;
  }
  const unsigned long long uid = std::strtoull(uid_s.c_str(), nullptr, 10);
  std::string name, ip, status;
  unsigned int port = 0;
  if (!svc.GetUserByUid(uid, &name, &ip, &port, &status)) {
    r.status = 404;
    r.body = "{\"ok\":false,\"error\":\"user not found\"}";
    return r;
  }
  r.status = 200;
  r.body = std::string("{\"ok\":true,\"uid\":") + std::to_string(uid) +
           ",\"username\":\"" + json_escape(name) +
           "\",\"ip\":\"" + json_escape(ip) +
           "\",\"port\":" + std::to_string(port) +
           ",\"status\":\"" + json_escape(status) + "\"}";
  return r;
}

bool SqlService::UpdateUserIpPort(const std::string& email_in,
                                  const std::string& ip,
                                  unsigned int port) {
  if (cfg_.backend != SqlConfig::Backend::File) return false;
  const std::string email = Trim(email_in);
  if (!IsValidEmail(email)) return false;

  std::lock_guard<std::mutex> lock(mu_);
  if (!LoadLocked()) return false;
  auto it = users_.find(email);
  if (it == users_.end()) return false;
  it->second.ip = ip;
  it->second.port = port;
  return SaveLocked();
}

bool SqlService::GetUserByUid(unsigned long long uid,
                               std::string* out_name,
                               std::string* out_ip,
                               unsigned int* out_port,
                               std::string* out_status) const {
  if (cfg_.backend != SqlConfig::Backend::File) return false;
  if (out_name) out_name->clear();
  if (out_ip) out_ip->clear();
  if (out_port) *out_port = 0;
  if (out_status) out_status->clear();

  std::lock_guard<std::mutex> lock(mu_);
  if (!LoadLocked()) return false;
  // Use uid index to avoid full scan.
  const auto it_uid = users_by_uid_.find(uid);
  if (it_uid == users_by_uid_.end()) return false;
  const auto it = users_.find(it_uid->second);
  if (it == users_.end()) return false;
  const UserRow& row = it->second;
  if (out_name) *out_name = row.name;
  if (out_ip)   *out_ip   = row.ip;
  if (out_port) *out_port = row.port;
  if (out_status) *out_status = row.status;
  return true;
}

bool SqlService::UpdateUserStatus(unsigned long long uid, const std::string& status_in) {
  if (cfg_.backend != SqlConfig::Backend::File) return false;
  const std::string status = Trim(status_in);

  std::lock_guard<std::mutex> lock(mu_);
  if (!LoadLocked()) return false;
  const auto it_uid = users_by_uid_.find(uid);
  if (it_uid == users_by_uid_.end()) return false;
  auto it = users_.find(it_uid->second);
  if (it == users_.end()) return false;
  it->second.status = status;
  return SaveLocked();
}

ApiResponse ApiRegister(SqlService& svc, const std::string& json_body) {
  ApiResponse r;
  const std::string username = json_get_field(json_body, "username");
  const std::string email = json_get_field(json_body, "email");
  const std::string password = json_get_field(json_body, "password");

  std::string err;
  if (!svc.RegisterUser(email, username, password, &err)) {
    r.status = 400;
    r.body = std::string("{\"ok\":false,\"error\":\"") + json_escape(err) + "\"}";
    return r;
  }

  r.status = 200;
  r.body = "{\"ok\":true}";
  return r;
}

ApiResponse ApiLogin(SqlService& svc, const std::string& json_body, const std::string& client_ip, unsigned int client_port) {
  ApiResponse r;
  std::string email = json_get_field(json_body, "email");
  if (email.empty()) email = json_get_field(json_body, "username");
  const std::string password = json_get_field(json_body, "password");

  unsigned long long uid = 0;
  std::string name;
  std::string err;
  if (!svc.VerifyLogin(email, password, &uid, &name, &err)) {
    r.status = 401;
    r.body = std::string("{\"ok\":false,\"error\":\"") + json_escape(err) + "\"}";
    return r;
  }

  // Update ip and port on every successful login
  svc.UpdateUserIpPort(email, client_ip, client_port);

  r.status = 200;
  r.body = std::string("{\"ok\":true,\"uid\":") + std::to_string(uid) +
           ",\"username\":\"" + json_escape(name) + "\"}";
  return r;
}

// ---------------------------------------------------------------------------
// EventQueue implementation
// ---------------------------------------------------------------------------
void EventQueue::Push(unsigned long long uid, const std::string& json_event) {
  std::lock_guard<std::mutex> lock(mu_);
  q_[uid].push_back({json_event, now_ms()});
}

void EventQueue::PushUnique(unsigned long long uid, const std::string& json_event) {
  std::lock_guard<std::mutex> lock(mu_);
  auto& dq = q_[uid];
  for (const auto& ev : dq) {
    if (ev.json == json_event) return;
  }
  dq.push_back({json_event, now_ms()});
}

std::int64_t EventQueue::ttl_for(const std::string& json) {
  // Fast prefix check — avoids JSON parse overhead on the hot path.
  if (json.find("\"rtc_") != std::string::npos) return kRtcEventTtlMs;
  return kDefaultEventTtlMs;
}

std::string EventQueue::Drain(unsigned long long uid) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = q_.find(uid);
  if (it == q_.end() || it->second.empty()) return "[]";

  const std::int64_t now = now_ms();
  std::string out;
  out.reserve(256);
  out += '[';
  bool any = false;

  auto& dq = it->second;
  // Walk the deque: skip expired events, emit live ones, compact in-place.
  std::size_t write = 0;
  for (std::size_t i = 0; i < dq.size(); ++i) {
    const std::int64_t age = now - dq[i].enqueue_ms;
    if (age > ttl_for(dq[i].json)) continue;  // expired — drop silently
    if (any) out += ',';
    out += dq[i].json;
    any = true;
    if (write != i) dq[write] = std::move(dq[i]);
    ++write;
  }
  // All live events were just delivered — clear the queue.
  dq.clear();

  out += ']';
  return out;
}

EventQueue& GetEventQueue() {
  static EventQueue q;
  return q;
}

ApiResponse ApiPollEvents(const std::string& json_body) {
  ApiResponse r;
  const std::string uid_s = json_get_field(json_body, "uid");
  if (uid_s.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"missing uid\"}";
    return r;
  }
  const unsigned long long uid = std::strtoull(uid_s.c_str(), nullptr, 10);
  const std::string events = GetEventQueue().Drain(uid);
  r.status = 200;
  r.body = std::string("{\"ok\":true,\"events\":") + events + "}";
  return r;
}

ApiResponse ApiAddFriend(const SqlService& svc, const std::string& json_body) {
  ApiResponse r;
  const std::string from_uid_s = json_get_field(json_body, "from_uid");
  const std::string to_uid_s   = json_get_field(json_body, "to_uid");
  const std::string from_name  = json_get_field(json_body, "from_name");

  if (from_uid_s.empty() || to_uid_s.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"missing from_uid or to_uid\"}";
    return r;
  }

  const unsigned long long from_uid = std::strtoull(from_uid_s.c_str(), nullptr, 10);
  const unsigned long long to_uid = std::strtoull(to_uid_s.c_str(), nullptr, 10);
  if (from_uid == 0 || to_uid == 0) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"invalid uid\"}";
    return r;
  }
  if (from_uid == to_uid) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"cannot_add_self\"}";
    return r;
  }
  std::string name;
  if (!svc.GetUserByUid(to_uid, &name, nullptr, nullptr, nullptr)) {
    r.status = 404;
    r.body = "{\"ok\":false,\"error\":\"target user not found\"}";
    return r;
  }

  // Enqueue event for target client to pick up via poll
  const std::string safe_from_name = from_name.empty() ? std::string("") : from_name;
  const std::string event = std::string("{\"type\":\"friend_request\",\"from_uid\":") + from_uid_s +
      ",\"from_name\":\"" + json_escape(safe_from_name) +
      "\",\"to_uid\":" + to_uid_s + "}";
  GetEventQueue().Push(to_uid, event);

  r.status = 200;
  r.body = "{\"ok\":true,\"msg\":\"friend request queued\"}";
  return r;
}

ApiResponse ApiFriendResponse(const SqlService& svc, const std::string& json_body) {
  ApiResponse r;
  const std::string from_uid_s = json_get_field(json_body, "from_uid");
  const std::string to_uid_s   = json_get_field(json_body, "to_uid");
  const std::string accept_s   = json_get_field(json_body, "accept");

  if (from_uid_s.empty() || to_uid_s.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"missing from_uid or to_uid\"}";
    return r;
  }

  const unsigned long long from_uid = std::strtoull(from_uid_s.c_str(), nullptr, 10);
  const unsigned long long to_uid = std::strtoull(to_uid_s.c_str(), nullptr, 10);
  if (from_uid == 0 || to_uid == 0) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"invalid uid\"}";
    return r;
  }
  std::string to_name;
  if (svc.GetUserByUid(to_uid, &to_name, nullptr, nullptr, nullptr)) {}

  // Enqueue response event for the original requester (from_uid)
  const bool accept = (accept_s == "true" || accept_s == "1");
  const std::string event = std::string("{\"type\":\"friend_response\",\"from_uid\":") + from_uid_s +
      ",\"to_uid\":" + to_uid_s +
      ",\"to_name\":\"" + json_escape(to_name) +
      "\",\"accept\":" + (accept ? "true" : "false") + "}";
  GetEventQueue().PushUnique(from_uid, event);

  r.status = 200;
  r.body = "{\"ok\":true,\"msg\":\"friend response queued\"}";
  return r;
}

ApiResponse ApiRemoveFriend(const std::string& json_body) {
  ApiResponse r;
  const std::string from_uid_s = json_get_field(json_body, "from_uid");
  const std::string to_uid_s   = json_get_field(json_body, "to_uid");

  if (from_uid_s.empty() || to_uid_s.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"missing from_uid or to_uid\"}";
    return r;
  }

  const unsigned long long from_uid = std::strtoull(from_uid_s.c_str(), nullptr, 10);
  const unsigned long long to_uid = std::strtoull(to_uid_s.c_str(), nullptr, 10);
  if (from_uid == 0 || to_uid == 0) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"invalid uid\"}";
    return r;
  }

  const std::string event = std::string("{\"type\":\"friend_removed\",\"from_uid\":") + from_uid_s +
      ",\"to_uid\":" + to_uid_s + "}";
  GetEventQueue().PushUnique(to_uid, event);

  r.status = 200;
  r.body = "{\"ok\":true,\"msg\":\"friend removed queued\"}";
  return r;
}

ApiResponse ApiUpdateStatus(SqlService& svc, const std::string& json_body) {
  ApiResponse r;
  const std::string uid_s = json_get_field(json_body, "uid");
  const std::string status = json_get_field(json_body, "status");
  if (uid_s.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"missing uid\"}";
    return r;
  }
  const unsigned long long uid = std::strtoull(uid_s.c_str(), nullptr, 10);
  if (uid == 0) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"invalid uid\"}";
    return r;
  }
  if (!svc.UpdateUserStatus(uid, status)) {
    r.status = 500;
    r.body = "{\"ok\":false,\"error\":\"status_update_failed\"}";
    return r;
  }
  r.status = 200;
  r.body = "{\"ok\":true}";
  return r;
}

// ---------------------------------------------------------------------------
// ApiCreateGroup
// Payload: {"from_uid":1,"group_name":"...","members":[2,3]}
// Enqueues group_created event to all members + creator.
// ---------------------------------------------------------------------------
ApiResponse ApiCreateGroup(const SqlService& svc, const std::string& json_body) {
  ApiResponse r;
  const std::string from_uid_s = json_get_field(json_body, "from_uid");
  const std::string group_name = json_get_field(json_body, "group_name");
  if (from_uid_s.empty() || group_name.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"missing from_uid or group_name\"}";
    return r;
  }
  const unsigned long long from_uid = std::strtoull(from_uid_s.c_str(), nullptr, 10);
  if (from_uid == 0) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"invalid from_uid\"}";
    return r;
  }

  std::vector<unsigned long long> members = json_get_uid_list(json_body, "members");
  if (members.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"members required\"}";
    return r;
  }

  // Ensure creator is included
  bool has_creator = false;
  for (auto uid : members) if (uid == from_uid) { has_creator = true; break; }
  if (!has_creator) members.push_back(from_uid);

  // Validate users exist
  std::vector<unsigned long long> valid;
  for (auto uid : members) {
    std::string uname;
    if (svc.GetUserByUid(uid, &uname, nullptr, nullptr, nullptr)) {
      valid.push_back(uid);
    }
  }
  if (valid.empty()) {
    r.status = 404;
    r.body = "{\"ok\":false,\"error\":\"no valid members\"}";
    return r;
  }

  // Generate a simple group id
  const std::string group_id = std::string("g-") + std::to_string(now_ms()) + "-" + from_uid_s;

  // Build members json array
  std::string members_json = "[";
  for (size_t i = 0; i < valid.size(); ++i) {
    if (i) members_json += ",";
    members_json += std::to_string(valid[i]);
  }
  members_json += "]";

  const std::string event = std::string("{\"type\":\"group_created\"") +
      ",\"group_id\":\"" + json_escape(group_id) + "\"" +
      ",\"group_name\":\"" + json_escape(group_name) + "\"" +
      ",\"members\":" + members_json + "}";

  for (auto uid : valid) {
    GetEventQueue().Push(uid, event);
  }

  r.status = 200;
  r.body = std::string("{\"ok\":true,\"group_id\":\"") + json_escape(group_id) + "\"}";
  return r;
}

// ---------------------------------------------------------------------------
// ApiSendGroupMessage
// Payload: {"from_uid":1,"group_id":"g-...","text":"...","msg_id":"...","from_name":"Tom"}
// Fans out message to all members in group_members list (client keeps list).
// ---------------------------------------------------------------------------
ApiResponse ApiSendGroupMessage(const SqlService& svc, const std::string& json_body) {
  ApiResponse r;
  const std::string from_uid_s = json_get_field(json_body, "from_uid");
  const std::string group_id   = json_get_field(json_body, "group_id");
  const std::string text       = json_get_field(json_body, "text");
  const std::string msg_id     = json_get_field(json_body, "msg_id");
  const std::string from_name  = json_get_field(json_body, "from_name");

  if (from_uid_s.empty() || group_id.empty() || text.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"missing from_uid, group_id or text\"}";
    return r;
  }

  // Members are provided in payload to allow stateless server fanout
  std::vector<unsigned long long> members = json_get_uid_list(json_body, "members");
  if (members.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"members required\"}";
    return r;
  }

  // Build message event
  const std::string event =
      std::string("{\"type\":\"group_message\"") +
      ",\"from_uid\":" + from_uid_s +
      ",\"from_name\":\"" + json_escape(from_name) + "\"" +
      ",\"group_id\":\"" + json_escape(group_id) + "\"" +
      ",\"text\":\"" + json_escape(text) + "\"" +
      ",\"msg_id\":\"" + json_escape(msg_id) + "\"" + "}";

  for (auto uid : members) {
    if (uid == 0) continue;
    GetEventQueue().Push(uid, event);
  }

  r.status = 200;
  r.body = "{\"ok\":true,\"msg\":\"group message queued\"}";
  return r;
}

// ---------------------------------------------------------------------------
// ApiUploadFile
// Payload: {"file_name":"...","mime":"...","size":12345,"content":"<base64>"}
// Stores file under web_root/uploads and returns URL.
// ---------------------------------------------------------------------------
ApiResponse ApiUploadFile(const std::string& json_body) {
  ApiResponse r;
  const std::string file_name = json_get_field(json_body, "file_name");
  const std::string mime = json_get_field(json_body, "mime");
  const std::string size_s = json_get_field(json_body, "size");
  const std::string content_b64 = json_get_field(json_body, "content");

  if (file_name.empty() || content_b64.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"missing file_name or content\"}";
    return r;
  }

  const unsigned long long size = std::strtoull(size_s.c_str(), nullptr, 10);
  if (size == 0 || size > 50ULL * 1024 * 1024) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"invalid size\"}";
    return r;
  }

  // Very small base64 decoder (no whitespace)
  auto decode_b64 = [](const std::string& in) -> std::string {
    static const std::string b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(in.size() * 3 / 4);
    int val = 0, valb = -8;
    for (unsigned char c : in) {
      if (c == '=') break;
      const auto pos = b64.find(c);
      if (pos == std::string::npos) continue;
      val = (val << 6) + (int) pos;
      valb += 6;
      if (valb >= 0) {
        out.push_back(char((val >> valb) & 0xFF));
        valb -= 8;
      }
    }
    return out;
  };

  const std::string data = decode_b64(content_b64);
  if (data.size() != size) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"size mismatch\"}";
    return r;
  }

  // sanitize filename
  std::string safe = file_name;
  for (char& ch : safe) {
    if (ch == '/' || ch == '\\') ch = '_';
  }
  if (safe.empty()) safe = "file";

  const std::string dir = "web_root/uploads";
  const std::string path = dir + "/" + safe;
  const std::string tmp_path = dir + "/.tmp_" + safe;

  // create directory if missing
#if defined(_WIN32)
  _mkdir("web_root");
  _mkdir(dir.c_str());
#else
  mkdir("web_root", 0755);
  mkdir(dir.c_str(), 0755);
#endif

  std::ofstream ofs(path, std::ios::binary);
  if (!ofs) {
    r.status = 500;
    r.body = "{\"ok\":false,\"error\":\"write failed\"}";
    return r;
  }
  ofs.write(data.data(), (std::streamsize) data.size());
  ofs.close();

  r.status = 200;
  r.body = std::string("{\"ok\":true,\"file_url\":\"/uploads/") +
           json_escape(safe) + "\",\"file_name\":\"" + json_escape(file_name) +
           "\",\"size\":" + std::to_string((unsigned long long) data.size()) + "}";
  return r;
}

// ---------------------------------------------------------------------------
// ApiUploadChunk
// Payload: {"file_name":"...","size":12345,"offset":0,"content":"<base64>"}
// Appends chunk to target file and returns next offset.
// ---------------------------------------------------------------------------
ApiResponse ApiUploadChunk(const std::string& json_body) {
  ApiResponse r;
  const std::string file_name = json_get_field(json_body, "file_name");
  const std::string size_s = json_get_field(json_body, "size");
  const std::string offset_s = json_get_field(json_body, "offset");
  const std::string content_b64 = json_get_field(json_body, "content");

  if (file_name.empty() || content_b64.empty() || offset_s.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"missing file_name, offset or content\"}";
    return r;
  }
  if (!is_allowed_upload_name(file_name)) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"file type not allowed\"}";
    return r;
  }

  const unsigned long long size = std::strtoull(size_s.c_str(), nullptr, 10);
  const unsigned long long offset = std::strtoull(offset_s.c_str(), nullptr, 10);
  if (size == 0 || size > 50ULL * 1024 * 1024) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"invalid size\"}";
    return r;
  }

  auto decode_b64 = [](const std::string& in) -> std::string {
    static const std::string b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(in.size() * 3 / 4);
    int val = 0, valb = -8;
    for (unsigned char c : in) {
      if (c == '=') break;
      const auto pos = b64.find(c);
      if (pos == std::string::npos) continue;
      val = (val << 6) + (int) pos;
      valb += 6;
      if (valb >= 0) {
        out.push_back(char((val >> valb) & 0xFF));
        valb -= 8;
      }
    }
    return out;
  };

  const std::string data = decode_b64(content_b64);
  if (offset + data.size() > size) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"size overflow\"}";
    return r;
  }

  std::string safe = file_name;
  for (char& ch : safe) {
    if (ch == '/' || ch == '\\') ch = '_';
  }
  if (safe.empty()) safe = "file";

  const std::string dir = "web_root/uploads";
  const std::string path = dir + "/" + safe;
  const std::string tmp_path = dir + "/.tmp_" + safe;

#if defined(_WIN32)
  _mkdir("web_root");
  _mkdir(dir.c_str());
#else
  mkdir("web_root", 0755);
  mkdir(dir.c_str(), 0755);
#endif

  std::fstream fs;
  if (offset == 0) {
    fs.open(tmp_path, std::ios::binary | std::ios::out | std::ios::trunc);
  } else {
    fs.open(tmp_path, std::ios::binary | std::ios::in | std::ios::out);
  }
  if (!fs) {
    r.status = 500;
    r.body = "{\"ok\":false,\"error\":\"open failed\"}";
    return r;
  }
  fs.seekp((std::streamoff) offset, std::ios::beg);
  fs.write(data.data(), (std::streamsize) data.size());
  fs.close();

  const unsigned long long next = offset + (unsigned long long) data.size();
  if (next >= size) {
    std::remove(path.c_str());
    std::rename(tmp_path.c_str(), path.c_str());
  }
  r.status = 200;
  r.body = std::string("{\"ok\":true,\"next_offset\":") + std::to_string(next) + "}";
  return r;
}

// ---------------------------------------------------------------------------
// ApiUploadCancel
// Payload: {"file_name":"..."}
// Deletes partial file from upload directory.
// ---------------------------------------------------------------------------
ApiResponse ApiUploadCancel(const std::string& json_body) {
  ApiResponse r;
  const std::string file_name = json_get_field(json_body, "file_name");
  if (file_name.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"missing file_name\"}";
    return r;
  }
  if (!is_allowed_upload_name(file_name)) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"file type not allowed\"}";
    return r;
  }
  std::string safe = file_name;
  for (char& ch : safe) {
    if (ch == '/' || ch == '\\') ch = '_';
  }
  const std::string path = std::string("web_root/uploads/") + safe;
  const std::string tmp_path = std::string("web_root/uploads/.tmp_") + safe;
  std::remove(path.c_str());
  std::remove(tmp_path.c_str());
  r.status = 200;
  r.body = "{\"ok\":true}";
  return r;
}

// ---------------------------------------------------------------------------
// RTC signaling relay: offer / answer / ice / hangup
// Validates uids, builds event JSON, pushes to target uid's queue.
// ---------------------------------------------------------------------------
static ApiResponse rtc_relay_event(const std::string& json_body, const char* type) {
  ApiResponse r;
  const std::string from_uid_s = json_get_field(json_body, "from_uid");
  const std::string to_uid_s   = json_get_field(json_body, "to_uid");
  if (from_uid_s.empty() || to_uid_s.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"missing from_uid or to_uid\"}";
    return r;
  }
  const unsigned long long to_uid = std::strtoull(to_uid_s.c_str(), nullptr, 10);
  if (to_uid == 0) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"invalid to_uid\"}";
    return r;
  }
  const bool is_offer  = (std::strcmp(type, "rtc_offer")  == 0);
  const bool is_answer = (std::strcmp(type, "rtc_answer") == 0);
  const bool is_ice    = (std::strcmp(type, "rtc_ice")    == 0);
  const bool is_hangup = (std::strcmp(type, "rtc_hangup") == 0);
  std::string event;
  event.reserve(256);
  event += "{\"type\":\"";
  event += type;
  event += "\",\"from_uid\":";
  event += from_uid_s;
  event += ",\"to_uid\":";
  event += to_uid_s;
  if (is_offer || is_answer) {
    const std::string sdp      = json_get_field(json_body, "sdp");
    const std::string sdp_type = json_get_field(json_body, "sdp_type");
    const std::string call_id  = json_get_field(json_body, "call_id");
    if (!sdp.empty()) {
      event += ",\"sdp\":\"";
      event += json_escape(sdp);
      event += '"';
    }
    if (!sdp_type.empty()) {
      event += ",\"sdp_type\":\"";
      event += json_escape(sdp_type);
      event += '"';
    }
    if (!call_id.empty()) {
      event += ",\"call_id\":\"";
      event += json_escape(call_id);
      event += '"';
    }
  } else if (is_ice) {
    const std::string candidate     = json_get_field(json_body, "candidate");
    const std::string sdp_mid       = json_get_field(json_body, "sdpMid");
    const std::string sdp_mline_idx = json_get_field(json_body, "sdpMLineIndex");
    const std::string call_id       = json_get_field(json_body, "call_id");
    if (!candidate.empty()) {
      event += ",\"candidate\":\"";
      event += json_escape(candidate);
      event += '"';
    }
    event += ",\"sdpMid\":\"";
    event += json_escape(sdp_mid);
    event += '"';
    event += ",\"sdpMLineIndex\":";
    event += sdp_mline_idx.empty() ? "0" : sdp_mline_idx;
    if (!call_id.empty()) {
      event += ",\"call_id\":\"";
      event += json_escape(call_id);
      event += '"';
    }
  } else if (is_hangup) {
    const std::string reason = json_get_field(json_body, "reason");
    const std::string call_id = json_get_field(json_body, "call_id");
    event += ",\"reason\":\"";
    event += (reason == "rejected") ? "rejected" : "ended";
    event += '"';
    if (!call_id.empty()) {
      event += ",\"call_id\":\"";
      event += json_escape(call_id);
      event += '"';
    }
  }
  event += '}';
  GetEventQueue().Push(to_uid, event);
  r.status = 200;
  r.body = "{\"ok\":true}";
  return r;
}

ApiResponse ApiRtcOffer(const std::string& json_body) {
  return rtc_relay_event(json_body, "rtc_offer");
}

ApiResponse ApiRtcAnswer(const std::string& json_body) {
  return rtc_relay_event(json_body, "rtc_answer");
}

ApiResponse ApiRtcIce(const std::string& json_body) {
  return rtc_relay_event(json_body, "rtc_ice");
}

ApiResponse ApiRtcHangup(const std::string& json_body) {
  return rtc_relay_event(json_body, "rtc_hangup");
}

// ---------------------------------------------------------------------------
// ApiRtcConfig
// Reads TURN config from env, returns {ok, urls, username, credential}
// Env:
//   QBE_TURN_URLS: comma-separated URLs (e.g. turn:host:3478?transport=udp)
//   QBE_TURN_USERNAME
//   QBE_TURN_CREDENTIAL
// ---------------------------------------------------------------------------
ApiResponse ApiRtcConfig() {
  ApiResponse r;
  static std::mutex cache_mu;
  static std::atomic<bool> cache_ready{false};
  static std::string cache_body;

  if (cache_ready.load(std::memory_order_acquire)) {
    r.status = 200;
    r.body = cache_body;
    return r;
  }

  std::lock_guard<std::mutex> lock(cache_mu);
  if (cache_ready.load(std::memory_order_acquire)) {
    r.status = 200;
    r.body = cache_body;
    return r;
  }

  char* urls = nullptr;
  char* user = nullptr;
  char* cred = nullptr;
  size_t sz_urls = 0;
  size_t sz_user = 0;
  size_t sz_cred = 0;

  const int rc_urls = _dupenv_s(&urls, &sz_urls, "QBE_TURN_URLS");
  if (rc_urls != 0 || urls == nullptr || *urls == '\0') {
    if (urls) free(urls);
    cache_body = "{\"ok\":true,\"enabled\":false}";
    cache_ready.store(true, std::memory_order_release);
    r.status = 200;
    r.body = cache_body;
    return r;
  }

  _dupenv_s(&user, &sz_user, "QBE_TURN_USERNAME");
  _dupenv_s(&cred, &sz_cred, "QBE_TURN_CREDENTIAL");

  std::string body = "{\"ok\":true,\"enabled\":true,\"urls\":\"";
  body += json_escape(urls);
  body += "\"";
  if (user && *user) {
    body += ",\"username\":\"";
    body += json_escape(user);
    body += "\"";
  }
  if (cred && *cred) {
    body += ",\"credential\":\"";
    body += json_escape(cred);
    body += "\"";
  }
  body += "}";

  if (urls) free(urls);
  if (user) free(user);
  if (cred) free(cred);

  cache_body = body;
  cache_ready.store(true, std::memory_order_release);
  r.status = 200;
  r.body = cache_body;
  return r;
}

// ---------------------------------------------------------------------------
// ApiSendMessage
// Payload: {"from_uid":1,"to_uid":2,"text":"hello","msg_id":"...","from_name":"Tom"}
// Enqueues a message event for to_uid so they receive it on next poll.
// ---------------------------------------------------------------------------
ApiResponse ApiSendMessage(const SqlService& svc, const std::string& json_body) {
  ApiResponse r;
  const std::string from_uid_s = json_get_field(json_body, "from_uid");
  const std::string to_uid_s   = json_get_field(json_body, "to_uid");
  const std::string text       = json_get_field(json_body, "text");
  const std::string msg_id     = json_get_field(json_body, "msg_id");
  const std::string from_name  = json_get_field(json_body, "from_name");

  if (from_uid_s.empty() || to_uid_s.empty() || text.empty()) {
    r.status = 400;
    r.body = "{\"ok\":false,\"error\":\"missing from_uid, to_uid or text\"}";
    return r;
  }

  const unsigned long long to_uid = std::strtoull(to_uid_s.c_str(), nullptr, 10);

  // Verify target user exists
  std::string to_name;
  if (!svc.GetUserByUid(to_uid, &to_name, nullptr, nullptr, nullptr)) {
    r.status = 404;
    r.body = "{\"ok\":false,\"error\":\"target user not found\"}";
    return r;
  }

  // Build message event JSON and push to event queue
  const std::string event =
      std::string("{\"type\":\"message\"") +
      ",\"from_uid\":" + from_uid_s +
      ",\"from_name\":\"" + json_escape(from_name) + "\"" +
      ",\"to_uid\":" + to_uid_s +
      ",\"text\":\"" + json_escape(text) + "\"" +
      ",\"msg_id\":\"" + json_escape(msg_id) + "\"}";

  GetEventQueue().Push(to_uid, event);

  r.status = 200;
  r.body = "{\"ok\":true,\"msg\":\"message queued\"}";
  return r;
}

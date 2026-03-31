# QBE 即时通讯软件

QBE 是一款高性能、轻量级的 B/S 架构即时通讯（IM）系统。后端采用 C++17 编写，核心依赖仅为一个嵌入式 Mongoose HTTP 服务器，无需 Nginx 或 Node.js 等额外依赖。

---

## ⚠️ 安全指南 (提交前必读)

为了确保数据安全性，我们已经彻底剥离了所有硬编码敏感信息。在生产环境部署时，请严格遵守以下规则：

### 1. 凭据环境变量映射
代码中已用 std::getenv 取代所有敏感信息，请在服务器设置以下环境变量：
- **QBE_DB_USER** / **QBE_DB_PASS**: 数据库连接凭据。
- **QBE_TURN_USERNAME** / **QBE_TURN_CREDENTIAL**: 用于 WebRTC 音视频中继的鉴权凭据。

### 2. 敏感文件保护
- **user_db.tsv**: 客户账号数据库，**严禁提交至 Git**。
- **硬编码过滤**: 所有公网 IP 地址均已使用 YOUR_DOMAIN 或 YOUR_IP 作为占位符，禁止提交您的真实服务器出口 IP。

---

## 核心技术特性

- **高性能后端**: 单可执行文件，利用多线程池模型处理高并发。
- **点对点通信**: 原生集成 WebRTC 信令协议，配合 coturn 服务器实现强穿透。
- **前端极简设计**: 采用纯 Vanilla JavaScript 编写，不依赖任何第三方重量级前端框架。
- **多功能支持**: 文字消息、音视频通话、大文件分片上传。

---

## 项目结构概览

`	ext
/BS_web_connect
├── main.cpp                # HTTP 服务器核心逻辑
├── sql.cpp / sql.h         # 用户状态机与数据库抽象层
├── threadpool.cpp / .h     # 高并发任务调度器
├── web_root/               # 前端静态资源
│   ├── client_connect.html # 主聊天页面
│   ├── client_connect.js   # 核心逻辑 (RTC/轮询/状态)
│   └── uploads/            # 媒体文件存取区 (请勿纳入版本控制)
└── TURN_SETUP.txt          # WebRTC 服务端配置手册
`

---

## 部署与构建指南

### 1. 编译环境
* **Windows**: 使用 Visual Studio 2022，配置项目为 x64-Release。
* **Linux**: 使用 GCC 9+ 或 Clang 10+，支持 C++17。

### 2. 运行环境准备
程序会自动查找 ./web_root 作为静态资源目录。请确保程序运行目录包含同级文件夹：
- user_db.tsv (首次注册自动生成)

### 3. 环境变量配置示例 (Linux)
`ash
export QBE_DB_USER="your_db_user"
export QBE_DB_PASS="your_secure_password"
./qbe_server
`

---

## REST API 概览

所有 API 遵循 POST /api/<feature> 格式，JSON 传输。

| 功能模块 | API 示例 |
| :--- | :--- |
| 账户 | /api/login, /api/register |
| 消息 | /api/send_message, /api/send_group_message |
| 实时同步 | /api/poll_events |
| WebRTC | /api/rtc_offer, /api/rtc_answer, /api/rtc_ice |

---

## 安全核对清单

- [ ] .gitignore 是否已忽略 user_db.tsv, *.exe, .vscode/, *.log?
- [ ] 代码中是否已完全移除真实 IP 和固定密码？
- [ ] 环境变量逻辑是否已生效？

---

## 🇺🇸 English Version

QBE is a high-performance, lightweight B/S architecture Instant Messaging (IM) system. The backend is written in C++17, with a minimal dependency on the embedded Mongoose HTTP server. No additional heavyweight frameworks like Nginx or Node.js are required.

### 🛡️ Security Guide (Read Before Commit)
1. **Never commit the database**: The user_db.tsv file contains encrypted user data. **NEVER** commit it via Git.
2. **Credential Management**: All hardcoded database and TURN credentials have been replaced with std::getenv calls. Please configure them via environment variables:
   - QBE_DB_USER / QBE_DB_PASS
   - QBE_TURN_USERNAME / QBE_TURN_CREDENTIAL
3. **IP & Domain Security**: Always use placeholders like YOUR_DOMAIN or YOUR_IP instead of real production IPs in your documentation or configuration files.

---

## 核心技术特性 / Key Features
- **High-Performance Backend**: Single executable, multi-threaded task scheduling.
- **P2P Communication**: Native WebRTC signaling with NAT traversal support via coturn.
- **Minimalist Frontend**: Pure Vanilla JavaScript with zero third-party framework dependencies.
- **Rich Functionality**: One-on-one text messages, video/audio calls, file chunking, and group management.

---

## 部署与构建指南 / Deployment Guide

### 1. Build Environment
* **Windows**: Visual Studio 2022, x64-Release configuration.
* **Linux**: GCC 9+ or Clang 10+ with C++17 support.

### 2. Quick Start (Linux)
`ash
g++ -std=c++17 -O2 -pthread main.cpp sql.cpp threadpool.cpp mongoose.c -o qbe_server
export QBE_DB_USER="your_db_user"
export QBE_DB_PASS="your_secure_password"
./qbe_server
`

---

## 快速入口 - 索引 (Index)

- [中文版目录 (Chinese Directory)](#目录)
- [安全指南 (Security Guide)](#⚠️-安全指南-提交前必读)
- [核心架构 (Core Architecture)](#核心架构)
- [部署与构建 (Deployment)](#部署与构建指南)
- [REST API 概览 (API Overview)](#rest-api-概览)

---

*This project is built for performance and security. Please ensure safe configuration before deploying to production.*

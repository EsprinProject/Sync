#!/usr/bin/env python3
import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import socket
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

SERVER_NAME = "EsprinSync"
SERVER_VERSION = 1
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8686
CONFIG_NAME = "config.json"
JOURNAL_NAME = "journal.log"
JOURNAL_ID_NAME = "journal.id"

USERS_FILE_NAME = "users.json"
USERS_DIR_NAME = "users"
# 每人的令牌放在自己的目录里，沿用旧版的文件名
TOKENS_FILE_NAME = "tokens.json"
# 内置账户：服务端始终保留它，不可删除、不可停用、不可取消管理员
DEFAULT_ACCOUNT_ID = "admin"
DEFAULT_ACCOUNT_NAME = "admin"
ACCOUNT_NAME_MAX = 32
# 旧版单账户布局：数据目录根下的 admin.json 与日志文件，首次启动时迁移进内置账户的目录
LEGACY_ADMIN_FILE_NAME = "admin.json"
# 账户 id 会当目录名用，Windows 上这几个名字不能作目录
RESERVED_DIR_NAMES = frozenset(
    ["con", "prn", "aux", "nul"]
    + ["com{}".format(index) for index in range(1, 10)]
    + ["lpt{}".format(index) for index in range(1, 10)]
)
ADMIN_COOKIE_NAME = "esprin_admin"
# 三个入口各占一段前缀：网页版客户端在根路径，管理后台在 /admin，同步接口在 /sync
SYNC_PATH = "/sync"
ADMIN_PATH = "/admin"
# 管理接口前缀：管理页挂在 /admin 下，接口随之挂在 /admin/api 下
API_PREFIX = ADMIN_PATH + "/api"
HEALTH_PATH = "/health"
# 网页版客户端在根路径：/ 返回页面，静态资源按白名单从 web/ 目录取。
# PWA 那几件（清单、Service Worker、图标）也都挂在根路径上，一并列进白名单
WEB_ASSET_PATHS = (
    "/favicon.png",
    "/manifest.webmanifest",
    "/sw.js",
    "/icon-180.png",
    "/icon-192.png",
    "/icon-512.png",
    "/icon-512-maskable.png",
)
WEB_ASSET_PREFIXES = ("/styles/", "/scripts/", "/fonts/")
# 管理后台在 /admin：页面静态资源（样式、脚本、图标、字体）从 manager/ 目录按 /admin/ 下的路径取
MANAGER_ASSET_PATHS = ("/app.css", "/app.js", "/favicon.png")
MANAGER_ASSET_PREFIXES = ("/fonts/",)
PBKDF2_ITERATIONS = 200_000
PBKDF2_SALT_BYTES = 16
SESSION_TTL_SECONDS = 12 * 60 * 60
LOGIN_WINDOW_SECONDS = 60
LOGIN_MAX_FAILURES = 10
TOKEN_TOUCH_INTERVAL_SECONDS = 60
MIN_PASSWORD_LENGTH = 8
DEFAULT_PAGE_LIMIT = 500
MAX_PAGE_LIMIT = 2000
MAX_DATA_CHARS = 8 * 1024 * 1024
FORBIDDEN_PATH_PARTS = ("..",)
# 可复用 ID（回收池）：
#   条目被删除后，它的路径会一直留在 deleted 里（别处的老副本因此不会被推回来），
#   但那个 ID 不必永久占着——新建条目时优先把 ID 还回去再用。
#   服务端只把同一个 ID 发给一台设备：领走的会被占住 RECYCLE_HOLD_SECONDS 秒，
#   直到条目真的被创建（put 会同时撤销删除记录与占位），或者占位超时自然回到池子里。
ITEM_PATH_PATTERN = re.compile(r"^(notes|todos)/([A-Za-z0-9_-]{1,64})\.md$")
RECYCLE_HOLD_SECONDS = 15 * 60
RECYCLE_POOL_LIMIT = 500
RECYCLE_CLAIM_MAX = 8


def now_ms():
    return int(time.time() * 1000)


def journal_download_name():
    return "esprin-journal-{}.log".format(time.strftime("%Y%m%d-%H%M%S"))


def sha256_text(text):
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def log(level, component, message):
    stream = sys.stderr if level in ("WARN", "ERROR") else sys.stdout
    stream.write("[{}] [{}] {}\n".format(level, component, message))
    stream.flush()


def normalize_relative_path(value):
    text = str(value or "").strip().replace("\\", "/")
    if not text:
        return ""
    if text.startswith("/"):
        return ""
    parts = [part for part in text.split("/") if part not in ("", ".")]
    if not parts or any(part in FORBIDDEN_PATH_PARTS for part in parts):
        return ""
    return "/".join(parts)


def parse_int(value, default, minimum, maximum):
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(number, maximum))


def hash_password(password, iterations=PBKDF2_ITERATIONS, salt=None):
    salt = salt or secrets.token_bytes(PBKDF2_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256${}${}${}".format(iterations, salt.hex(), digest.hex())


def verify_password(password, stored):
    try:
        scheme, iterations, salt_hex, digest_hex = str(stored).split("$")
        if scheme != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations))
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


class UserStore:
    """账户、登录会话、访问令牌与各账户的数据日志。

    数据布局：
      <data>/users.json                     账户列表（姓名、密码摘要、角色、状态）与服务端密钥
      <data>/users/<账户 id>/journal.log    该账户的全部数据
      <data>/users/<账户 id>/journal.id     该账户的日志身份
      <data>/users/<账户 id>/tokens.json    该账户的访问令牌摘要

    每个账户一份独立的操作日志，账户之间互不可见。旧版把日志、令牌、密码摘要
    直接放在数据目录根下，首次启动时会迁移成 id 为 admin 的账户（见 _migrate_legacy_files）。
    """

    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.users_path = os.path.join(data_dir, USERS_FILE_NAME)
        self.lock = threading.RLock()
        self.secret = ""
        self.users = []
        # 账户 id -> 令牌记录列表 / 操作日志对象
        self.tokens = {}
        self.journals = {}
        self.sessions = {}
        self.failures = {}
        self._load()

    def _load(self):
        os.makedirs(self.data_dir, exist_ok=True)

        if not self._load_users_file():
            self._bootstrap_users()

        # 内置账户必须始终在：它被从 users.json 里删掉时补一个回来，避免把自己锁在门外
        if not self.find_user(DEFAULT_ACCOUNT_ID):
            self.users.append({
                "id": DEFAULT_ACCOUNT_ID,
                "name": DEFAULT_ACCOUNT_NAME,
                "password": "",
                "admin": True,
                "enabled": True,
                "createdAt": now_ms(),
                "lastLoginAt": 0,
            })
            self._save_users()
            log("WARN", "Users", "users.json 里缺少内置账户，已补回 (id={})".format(DEFAULT_ACCOUNT_ID))

        if not self.secret:
            self.secret = secrets.token_hex(32)
            self._save_users()

        self._migrate_legacy_files()
        for user in self.users:
            self._load_tokens(user["id"])

    def _load_users_file(self):
        try:
            with open(self.users_path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            return False
        if not isinstance(data, dict) or not isinstance(data.get("users"), list):
            return False

        loaded = []
        for item in data["users"]:
            if not isinstance(item, dict):
                continue
            user_id = str(item.get("id") or "").strip()
            name = str(item.get("name") or "").strip()
            if not user_id or not name:
                continue
            loaded.append({
                "id": user_id,
                "name": name,
                "password": str(item.get("password") or ""),
                "admin": bool(item.get("admin")),
                "enabled": item.get("enabled", True) is not False,
                "createdAt": int(item.get("createdAt") or 0),
                "lastLoginAt": int(item.get("lastLoginAt") or 0),
            })
        if not loaded:
            return False

        self.secret = str(data.get("secret") or "")
        self.users = loaded
        # 内置账户恒为管理员且恒启用
        builtin = self.find_user(DEFAULT_ACCOUNT_ID)
        if builtin:
            builtin["admin"] = True
            builtin["enabled"] = True
        return True

    def _bootstrap_users(self):
        """首次启动：建内置账户。旧版 admin.json 里的密码摘要与密钥在这里接过来。"""
        password = ""
        secret = ""
        legacy_path = os.path.join(self.data_dir, LEGACY_ADMIN_FILE_NAME)
        try:
            with open(legacy_path, "r", encoding="utf-8") as handle:
                legacy = json.load(handle)
            if isinstance(legacy, dict):
                password = str(legacy.get("password") or "")
                secret = str(legacy.get("secret") or "")
        except (OSError, ValueError):
            pass

        self.secret = secret or self.secret or secrets.token_hex(32)
        self.users = [{
            "id": DEFAULT_ACCOUNT_ID,
            "name": DEFAULT_ACCOUNT_NAME,
            "password": password,
            "admin": True,
            "enabled": True,
            "createdAt": now_ms(),
            "lastLoginAt": 0,
        }]
        # 账户表丢了、但数据目录还在时，把那些账户补成占位（密码无从恢复，由管理员重设）：
        # 否则那些目录里的数据既进不去、也看不见。
        recovered = self._recover_account_dirs()
        self._save_users()
        log("INFO", "Users", "已初始化账户表: 内置账户={} 沿用旧密码={} 补回账户={}".format(
            DEFAULT_ACCOUNT_NAME, bool(password), recovered))

        # 旧文件已读过一次：改名归档，免得日后再读到里面那份过期的密码摘要
        if password or secret:
            try:
                os.replace(legacy_path, legacy_path + ".migrated")
                log("INFO", "Users", "旧版 admin.json 已归档为 {}(不再被读取)".format(
                    LEGACY_ADMIN_FILE_NAME + ".migrated"))
            except OSError as error:
                log("WARN", "Users", "归档旧版 admin.json 失败: {} (path={})".format(error, legacy_path))

    def _recover_account_dirs(self):
        """列出 users/ 下已有的账户目录，补成没有密码的占位账户（管理员重设密码后即可登录）。"""
        root = os.path.join(self.data_dir, USERS_DIR_NAME)
        if not os.path.isdir(root):
            return 0
        count = 0
        for name in sorted(os.listdir(root)):
            if name == DEFAULT_ACCOUNT_ID or not os.path.isdir(os.path.join(root, name)):
                continue
            if self._validate_name(name):
                continue
            self.users.append({
                "id": name,
                "name": name,
                "password": "",
                "admin": False,
                "enabled": True,
                "createdAt": now_ms(),
                "lastLoginAt": 0,
            })
            count += 1
        if count:
            log("WARN", "Users", "账户表缺失，已按数据目录补回 {} 个账户，密码需重新设置".format(count))
        return count

    def _migrate_legacy_files(self):
        """旧版把日志与令牌放在数据目录根下：搬进内置账户的目录（原文件不再保留）。"""
        target_dir = self.user_dir(DEFAULT_ACCOUNT_ID)
        moved = []
        for name in (JOURNAL_NAME, JOURNAL_ID_NAME, TOKENS_FILE_NAME):
            source = os.path.join(self.data_dir, name)
            if not os.path.isfile(source):
                continue
            target = os.path.join(target_dir, name)
            if os.path.exists(target):
                continue
            try:
                os.makedirs(target_dir, exist_ok=True)
                os.replace(source, target)
                moved.append(name)
            except OSError as error:
                log("ERROR", "Users", "迁移旧版文件失败: {} (from={} to={})".format(error, source, target))
        if moved:
            log("INFO", "Users", "已迁移旧版单账户数据: dir={} files={}".format(target_dir, ",".join(moved)))

    def _save_users(self):
        self._write_json(self.users_path, {
            "version": 1,
            "secret": self.secret,
            "users": self.users,
        })

    def _write_json(self, path, value):
        try:
            temp = "{}.tmp".format(path)
            with open(temp, "w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False, indent=2)
            os.replace(temp, path)
        except OSError as error:
            log("ERROR", "Users", "写入失败: {} (path={})".format(error, path))

    # ---------------- 账户 ----------------

    def find_user(self, user_id):
        wanted = str(user_id or "")
        for user in self.users:
            if user["id"] == wanted:
                return user
        return None

    def find_user_by_name(self, name):
        wanted = str(name or "").strip().casefold()
        if not wanted:
            return None
        for user in self.users:
            if user["name"].casefold() == wanted:
                return user
        return None

    def builtin_user(self):
        """内置账户（admin）：不可删除、不可停用、不可取消管理员。"""
        return self.find_user(DEFAULT_ACCOUNT_ID)

    def password_set(self):
        user = self.builtin_user()
        return bool(user and user.get("password"))

    def set_password(self, password):
        """给内置账户设首次密码；已设过则拒绝（此后走 change_password）。"""
        with self.lock:
            user = self.builtin_user()
            if not user or user.get("password"):
                return False
            user["password"] = hash_password(password)
            self._save_users()
            return True

    def change_password(self, user_id, old_password, new_password):
        with self.lock:
            user = self.find_user(user_id)
            if not user or not verify_password(old_password, user.get("password") or ""):
                return False
            user["password"] = hash_password(new_password)
            # 换密码即断开该账户已登录的浏览器
            self.destroy_user_sessions(user["id"])
            self._save_users()
            return True

    def reset_password(self, user_id, password):
        """管理员给其他账户重设密码：不需要原密码，重设后该账户的登录会话立即失效。"""
        with self.lock:
            user = self.find_user(user_id)
            if not user:
                return False, "找不到该账户"
            if len(str(password or "")) < MIN_PASSWORD_LENGTH:
                return False, "密码至少 {} 位".format(MIN_PASSWORD_LENGTH)
            user["password"] = hash_password(password)
            self.destroy_user_sessions(user["id"])
            self._save_users()
            return True, ""

    def list_users(self):
        with self.lock:
            return [self.describe_user(user) for user in self._sorted_users()]

    def describe_user(self, user):
        summary = self.journal(user["id"]).summary()
        return {
            "id": user["id"],
            "name": user["name"],
            "admin": bool(user["admin"]),
            "enabled": bool(user["enabled"]),
            "builtIn": user["id"] == DEFAULT_ACCOUNT_ID,
            "passwordSet": bool(user.get("password")),
            "createdAt": int(user.get("createdAt") or 0),
            "lastLoginAt": int(user.get("lastLoginAt") or 0),
            "tokenCount": len(self.tokens.get(user["id"]) or []),
            "journal": {
                "ops": summary["ops"],
                "files": summary["files"],
                "deleted": summary["deleted"],
                "recyclable": summary["recyclable"],
                "size": summary["size"],
                "exists": summary["exists"],
            },
        }

    def _sorted_users(self):
        # 内置账户排在最前，其余按创建时间
        return sorted(self.users,
                      key=lambda item: (item["id"] != DEFAULT_ACCOUNT_ID, item.get("createdAt") or 0))

    def _validate_name(self, name, exclude_id=""):
        text = str(name or "").strip()
        if not text:
            return "账户名不能为空"
        if len(text) > ACCOUNT_NAME_MAX:
            return "账户名最多 {} 个字符".format(ACCOUNT_NAME_MAX)
        if any(part in text for part in ("/", "\\")) or any(ord(char) < 32 for char in text):
            return "账户名不能包含斜杠或控制字符"
        for user in self.users:
            if user["id"] != exclude_id and user["name"].casefold() == text.casefold():
                return "账户名已存在"
        return ""

    def _make_id(self, name):
        """账户 id 会当目录名用：纯 ASCII 的名字直接当 id，其余用随机串。"""
        taken = {user["id"].casefold() for user in self.users}
        slug = re.sub(r"[^a-z0-9_-]+", "", str(name or "").lower())[:24].strip("-_")
        if slug and slug not in taken and slug not in RESERVED_DIR_NAMES:
            return slug
        for _ in range(16):
            candidate = "u_" + secrets.token_hex(6)
            if candidate.casefold() not in taken:
                return candidate
        return "u_" + uuid.uuid4().hex

    def create_user(self, name, password, is_admin=False):
        with self.lock:
            text = str(name or "").strip()
            error = self._validate_name(text)
            if error:
                return None, error
            if len(str(password or "")) < MIN_PASSWORD_LENGTH:
                return None, "密码至少 {} 位".format(MIN_PASSWORD_LENGTH)
            user = {
                "id": self._make_id(text),
                "name": text,
                "password": hash_password(password),
                "admin": bool(is_admin),
                "enabled": True,
                "createdAt": now_ms(),
                "lastLoginAt": 0,
            }
            self.users.append(user)
            self.tokens[user["id"]] = []
            self._save_users()
            log("INFO", "Users", "新建账户: name={} id={} admin={}".format(text, user["id"], user["admin"]))
            return self.describe_user(user), ""

    def update_user(self, user_id, name=None, enabled=None, is_admin=None):
        with self.lock:
            user = self.find_user(user_id)
            if not user:
                return None, "找不到该账户"
            builtin = user["id"] == DEFAULT_ACCOUNT_ID
            if name is not None and str(name).strip() != user["name"]:
                if builtin:
                    return None, "内置账户 {} 不能改名".format(DEFAULT_ACCOUNT_NAME)
                error = self._validate_name(name, user["id"])
                if error:
                    return None, error
                user["name"] = str(name).strip()
            if enabled is not None:
                if builtin and not enabled:
                    return None, "内置账户 {} 不能停用".format(DEFAULT_ACCOUNT_NAME)
                user["enabled"] = bool(enabled)
                if not user["enabled"]:
                    self.destroy_user_sessions(user["id"])
            if is_admin is not None:
                if builtin and not is_admin:
                    return None, "内置账户 {} 不能取消管理员".format(DEFAULT_ACCOUNT_NAME)
                user["admin"] = bool(is_admin)
            self._save_users()
            log("INFO", "Users", "更新账户: name={} id={} enabled={} admin={}".format(
                user["name"], user["id"], user["enabled"], user["admin"]))
            return self.describe_user(user), ""

    def delete_user(self, user_id):
        with self.lock:
            user = self.find_user(user_id)
            if not user:
                return False, "找不到该账户"
            if user["id"] == DEFAULT_ACCOUNT_ID:
                return False, "内置账户 {} 不能删除".format(DEFAULT_ACCOUNT_NAME)
            self.users = [item for item in self.users if item["id"] != user["id"]]
            self.tokens.pop(user["id"], None)
            self.journals.pop(user["id"], None)
            self.destroy_user_sessions(user["id"])
            self._save_users()
            name, removed_id = user["name"], user["id"]

        # 账户目录连同数据一起删掉
        target = self.user_dir(removed_id)
        data_removed = False
        if os.path.isdir(target):
            try:
                shutil.rmtree(target)
                data_removed = True
            except OSError as error:
                log("ERROR", "Users", "删除账户目录失败: {} (path={})".format(error, target))
        log("INFO", "Users", "已删除账户: name={} id={} dataRemoved={}".format(name, removed_id, data_removed))
        return True, ""

    def authenticate(self, name, password):
        """按账户名 + 密码校验。账户不存在与密码错误返回同一句提示，不透露账户是否存在。"""
        with self.lock:
            text = str(name or "").strip()
            user = self.find_user_by_name(text) if text else self.builtin_user()
            if not user or not verify_password(password, user.get("password") or ""):
                return None, "账户名或密码不正确"
            if not user["enabled"]:
                return None, "该账户已停用"
            user["lastLoginAt"] = now_ms()
            self._save_users()
            return user, ""

    # ---------------- 访问令牌 ----------------

    def _token_records(self, user_id):
        return self.tokens.setdefault(str(user_id), [])

    def _tokens_path(self, user_id):
        return os.path.join(self.user_dir(user_id), TOKENS_FILE_NAME)

    def _load_tokens(self, user_id):
        try:
            with open(self._tokens_path(user_id), "r", encoding="utf-8") as handle:
                data = json.load(handle)
            records = data.get("tokens") if isinstance(data, dict) else None
            if isinstance(records, list):
                self.tokens[user_id] = [item for item in records if isinstance(item, dict) and item.get("id")]
        except (OSError, ValueError):
            pass

    def _save_tokens(self, user_id):
        os.makedirs(self.user_dir(user_id), exist_ok=True)
        self._write_json(self._tokens_path(user_id), {"version": 1, "tokens": self._token_records(user_id)})

    def token_count(self):
        with self.lock:
            return sum(len(records) for records in self.tokens.values())

    def user_dir(self, user_id):
        return os.path.join(self.data_dir, USERS_DIR_NAME, str(user_id))

    def journal(self, user_id):
        """取某账户的操作日志（首次访问时读盘建索引）。"""
        with self.lock:
            user_id = str(user_id)
            found = self.journals.get(user_id)
            if found is None:
                found = Journal(self.user_dir(user_id))
                self.journals[user_id] = found
            return found

    # ---------------- 登录会话 ----------------

    def create_session(self, user_id, ip):
        with self.lock:
            now = now_ms()
            self.sessions = {
                key: value for key, value in self.sessions.items()
                if now - value["lastSeenAt"] < SESSION_TTL_SECONDS * 1000
            }
            session_id = secrets.token_urlsafe(32)
            self.sessions[session_id] = {
                "userId": str(user_id), "createdAt": now, "lastSeenAt": now, "ip": ip,
            }
            return session_id

    def touch_session(self, session_id):
        """会话有效时返回它，过期或不存在返回 None。"""
        with self.lock:
            session = self.sessions.get(session_id)
            if not session:
                return None
            now = now_ms()
            if now - session["lastSeenAt"] > SESSION_TTL_SECONDS * 1000:
                self.sessions.pop(session_id, None)
                return None
            session["lastSeenAt"] = now
            return session

    def session_user(self, session_id):
        """会话对应的账户；账户已被删除或停用时连会话一起作废。"""
        session = self.touch_session(session_id)
        if not session:
            return None, None
        user = self.find_user(session.get("userId"))
        if not user or not user["enabled"]:
            self.destroy_session(session_id)
            return None, None
        return user, session

    def destroy_session(self, session_id):
        with self.lock:
            self.sessions.pop(session_id, None)

    def destroy_user_sessions(self, user_id):
        with self.lock:
            self.sessions = {
                key: value for key, value in self.sessions.items()
                if value.get("userId") != str(user_id)
            }

    def login_allowed(self, ip):
        with self.lock:
            now = time.time()
            history = [stamp for stamp in self.failures.get(ip, []) if now - stamp < LOGIN_WINDOW_SECONDS]
            self.failures[ip] = history
            return len(history) < LOGIN_MAX_FAILURES

    def note_login_failure(self, ip):
        with self.lock:
            self.failures.setdefault(ip, []).append(time.time())

    def _digest(self, token):
        return hmac.new(self.secret.encode("utf-8"), token.encode("utf-8"), hashlib.sha256).hexdigest()

    def _find_by_id(self, user_id, token_id):
        for item in self._token_records(user_id):
            if item.get("id") == token_id:
                return item
        return None

    def list_tokens(self, user_id):
        with self.lock:
            return [{key: value for key, value in item.items() if key != "digest"}
                    for item in self._token_records(user_id)]

    def create_token(self, user_id, name, device):
        with self.lock:
            token = "esn_" + secrets.token_urlsafe(24)
            record = {
                "id": "tk_" + secrets.token_hex(6),
                "name": str(name or "").strip() or "未命名设备",
                "device": str(device or "").strip(),
                "digest": self._digest(token),
                "createdAt": now_ms(),
                "lastUsedAt": 0,
                "lastDeviceId": "",
                "enabled": True,
            }
            self._token_records(user_id).append(record)
            self._save_tokens(user_id)
            return record["id"], token

    def rotate_token(self, user_id, token_id):
        with self.lock:
            record = self._find_by_id(user_id, token_id)
            if not record:
                return None
            token = "esn_" + secrets.token_urlsafe(24)
            record["digest"] = self._digest(token)
            record["lastUsedAt"] = 0
            self._save_tokens(user_id)
            return token

    def update_token(self, user_id, token_id, name=None, device=None, enabled=None):
        with self.lock:
            record = self._find_by_id(user_id, token_id)
            if not record:
                return None
            if name is not None:
                record["name"] = str(name).strip() or record.get("name", "")
            if device is not None:
                record["device"] = str(device).strip()
            if enabled is not None:
                record["enabled"] = bool(enabled)
            self._save_tokens(user_id)
            return {key: value for key, value in record.items() if key != "digest"}

    def delete_token(self, user_id, token_id):
        with self.lock:
            records = self._token_records(user_id)
            before = len(records)
            self.tokens[user_id] = [item for item in records if item.get("id") != token_id]
            if len(self.tokens[user_id]) == before:
                return False
            self._save_tokens(user_id)
            return True

    def find_token_by_plain(self, token):
        """按明文找令牌：返回 (账户 id, 记录)；令牌可以属于任何一个账户。"""
        if not token:
            return None, None
        digest = self._digest(token)
        with self.lock:
            for user_id, records in self.tokens.items():
                for item in records:
                    if hmac.compare_digest(str(item.get("digest") or ""), digest):
                        return user_id, item
        return None, None

    def note_token_use(self, user_id, record, device_id):
        with self.lock:
            now = now_ms()
            changed = False
            if device_id and record.get("lastDeviceId") != device_id:
                record["lastDeviceId"] = device_id
                changed = True
            if now - int(record.get("lastUsedAt") or 0) > TOKEN_TOUCH_INTERVAL_SECONDS * 1000:
                record["lastUsedAt"] = now
                changed = True
            if changed:
                self._save_tokens(user_id)


class Journal:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.path = os.path.join(data_dir, JOURNAL_NAME)
        self.lock = threading.Lock()
        self.latest_seq = 0
        self.op_ids = {}
        self.files = {}
        self.deleted = {}
        # 删除记录是哪台设备删的（path → device）：发起删除的那一台可以立刻把 ID 领回去用
        self.deleted_by = {}
        # 已被某台设备领走、还在等它把条目建回来的 ID（path → {device, until}）
        self.holds = {}
        self.count = 0
        self._load()
        self.journal_id = self._load_or_create_id()

    def _load_or_create_id(self):
        path = os.path.join(self.data_dir, JOURNAL_ID_NAME)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                value = handle.read().strip()
            if value:
                return value
        except OSError:
            pass

        value = uuid.uuid4().hex
        try:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(value)
        except OSError:
            pass
        return value

    def _load(self):
        os.makedirs(self.data_dir, exist_ok=True)
        if not os.path.exists(self.path):
            return

        with open(self.path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                self._index(entry)

    def _index(self, entry):
        seq = int(entry.get("seq") or 0)
        if seq <= 0:
            return
        self.latest_seq = max(self.latest_seq, seq)
        self.count += 1
        op_id = entry.get("opId")
        if op_id:
            self.op_ids[op_id] = seq
        # 删除标记上记着已经抹掉的那些操作号：客户端断线重试同一个 opId 时照样算「收过」
        for purged_id in entry.get("purged") or []:
            if purged_id:
                self.op_ids.setdefault(str(purged_id), seq)

        path = entry.get("path")
        if not path:
            return
        if entry.get("op") == "del":
            # 删除：记下删除记录（tombstone，别处的老副本不会被推回来），并把存活索引里的那条拿掉
            self.files.pop(path, None)
            self.deleted[path] = seq
            self.deleted_by[path] = str(entry.get("device") or "")
        else:
            self.files[path] = {"hash": entry.get("hash", ""), "seq": seq, "device": entry.get("device", "")}
            # 条目被重新创建（可能是用回收的 ID 建的）：删除记录与领走 ID 的占位一并撤销
            self.deleted.pop(path, None)
            self.deleted_by.pop(path, None)
            self.holds.pop(path, None)

    def append_many(self, device, ops):
        accepted = []
        with self.lock:
            with open(self.path, "a", encoding="utf-8") as handle:
                for raw in ops:
                    op_id = str(raw.get("opId") or "")
                    if op_id and op_id in self.op_ids:
                        accepted.append({"opId": op_id, "seq": self.op_ids[op_id], "duplicate": True})
                        continue

                    kind = raw.get("op")
                    if kind not in ("put", "del"):
                        accepted.append({"opId": op_id, "seq": 0, "error": "未知操作类型"})
                        continue

                    path = normalize_relative_path(raw.get("path"))
                    if not path:
                        accepted.append({"opId": op_id, "seq": 0, "error": "路径不合法"})
                        continue

                    entry = {
                        "seq": self.latest_seq + 1,
                        "opId": op_id,
                        "device": str(raw.get("device") or device or ""),
                        "time": int(raw.get("time") or now_ms()),
                        "op": kind,
                        "path": path,
                    }
                    if kind == "put":
                        data = raw.get("data")
                        if not isinstance(data, str):
                            accepted.append({"opId": op_id, "seq": 0, "error": "put 缺少内容"})
                            continue
                        if len(data) > MAX_DATA_CHARS:
                            accepted.append({"opId": op_id, "seq": 0, "error": "内容过大"})
                            continue
                        entry["data"] = data
                        entry["encoding"] = "base64" if raw.get("encoding") == "base64" else "utf8"
                        entry["hash"] = raw.get("hash") or (
                            sha256_text(data) if entry["encoding"] == "utf8" else ""
                        )
                    else:
                        entry["hash"] = raw.get("hash") or ""

                    handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
                    handle.flush()
                    os.fsync(handle.fileno())

                    self._index(entry)
                    accepted.append({"opId": op_id, "seq": entry["seq"]})

        return accepted

    def read_ops(self, since, limit):
        result = []
        if not os.path.exists(self.path):
            return result

        with open(self.path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                seq = int(entry.get("seq") or 0)
                if seq <= since:
                    continue
                result.append(entry)
                if len(result) >= limit:
                    break
        return result

    def read_file(self, path):
        latest = None
        if not os.path.exists(self.path):
            return None
        with open(self.path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("path") != path:
                    continue
                latest = entry
        if not latest or latest.get("op") != "put":
            return None
        return latest

    def _recyclable(self):
        """可复用的 ID：被删除过、此后没有再被创建过的条目标。
        按删除时的序号倒序（刚删掉的最先被复用——那正是发起删除的设备刚腾出来的 ID），
        刚被别的设备领走还没落盘的不在其中。调用方需持有 self.lock。"""
        now = now_ms()
        pool = []
        for path, seq in self.deleted.items():
            if path in self.files:
                continue
            match = ITEM_PATH_PATTERN.match(path)
            if not match:
                continue
            hold = self.holds.get(path)
            if hold:
                if now < int(hold.get("until") or 0):
                    continue
                self.holds.pop(path, None)
            pool.append({"id": match.group(2), "kind": match.group(1), "path": path, "seq": seq,
                         "device": self.deleted_by.get(path, "")})
        pool.sort(key=lambda item: item["seq"], reverse=True)
        return pool

    def recyclable(self, limit=RECYCLE_POOL_LIMIT):
        with self.lock:
            return self._recyclable()[:max(0, int(limit))]

    def compact(self, paths=None):
        """把已经彻底删除的路径的历史从日志里抹掉，每个这样的路径只留最后那一条删除标记。

        删除必须留下痕迹：别的设备靠它知道这个路径已删（本地残留的老副本不会被推回来），
        回收池也靠它知道哪个 ID 可以再用。但它以前写过什么、改过多少次都没必要留着——
        「彻底删除」就该真的从日志里消失。

        其余操作的序号一个不动（序号有空洞不影响按 since 增量拉取），
        各设备记的「已应用到第几号」因此照旧有效。
        paths 给定时只整理这些路径（客户端推上一条删除之后就只整理那一条）。
        """
        wanted = None
        if paths is not None:
            wanted = {normalize_relative_path(item) for item in paths}
            wanted.discard("")

        with self.lock:
            if not os.path.isfile(self.path):
                return {"removed": 0, "kept": 0, "paths": 0}

            with open(self.path, "r", encoding="utf-8") as handle:
                entries = []
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entries.append((json.loads(line), line))
                    except json.JSONDecodeError:
                        entries.append((None, line))

            # 每条路径最后一条操作是什么、落在哪一行
            last_op = {}
            last_index = {}
            for index, (entry, _line) in enumerate(entries):
                path = entry.get("path") if entry else None
                if not path:
                    continue
                last_op[path] = entry.get("op")
                last_index[path] = index

            # 最后一条是删除的路径：以前的行全部去掉，只留那条删除标记
            removable = {path for path, op in last_op.items()
                         if op == "del" and (wanted is None or path in wanted)}
            markers = {last_index[path] for path in removable}

            # 被抹掉的那些操作号记在删除标记上：客户端断线重试同一个 opId 时，
            # 服务端还能认出「这条已经收过了」，不会把已经删掉的内容又写回来。
            # （操作号里只有设备与时间，不含路径与正文。）
            purged = {}
            for index, (entry, _line) in enumerate(entries):
                if not entry:
                    continue
                path = entry.get("path")
                if path not in removable:
                    continue
                # 留下来的那条标记：把它以前记着的操作号继续带上
                if index in markers:
                    for op_id in entry.get("purged") or []:
                        purged.setdefault(path, set()).add(str(op_id))
                    continue
                # 要被抹掉的每一行：它自己的操作号，以及它以前记着的（老标记），都并到新标记上
                if entry.get("opId"):
                    purged.setdefault(path, set()).add(str(entry["opId"]))
                for op_id in entry.get("purged") or []:
                    purged.setdefault(path, set()).add(str(op_id))

            kept = []
            for index, (entry, line) in enumerate(entries):
                if entry is not None and index not in markers and entry.get("path") in removable:
                    continue  # 彻底删掉的条目：以前写过的都抹掉
                if entry is not None and index in markers and purged.get(entry.get("path")):
                    marker = dict(entry)
                    marker["purged"] = sorted(purged[entry["path"]])
                    kept.append((marker, json.dumps(marker, ensure_ascii=False)))
                    continue
                kept.append((entry, line))

            removed = len(entries) - len(kept)
            if removed:
                temp = "{}.tmp".format(self.path)
                with open(temp, "w", encoding="utf-8") as handle:
                    for _entry, line in kept:
                        handle.write(line + "\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp, self.path)
                self._rebuild(kept)
            return {"removed": removed, "kept": len(kept), "paths": len(removable)}

    def _rebuild(self, kept):
        """日志整理过之后重算内存索引。序号保持原值（最后一个行永远会被留下，
        因此 latest_seq 不变），各设备记的游标照旧能用。"""
        self.latest_seq = 0
        self.op_ids = {}
        self.files = {}
        self.deleted = {}
        self.deleted_by = {}
        self.count = 0
        # self.holds 不动：那是「已领走、等条目落盘」的内存占位，与日志无关
        for entry, _line in kept:
            if entry:
                self._index(entry)

    def claim_recyclable(self, device, kind="", count=1, since=None):
        """把回收池里最近删掉的那几个 ID 交给调用方，并在服务端把它们占住：
        两台设备同时新建时不会领到同一个 ID。同类型的优先（笔记的 ID 给笔记用），
        池子里没有同类型就从别的类型里匀——ID 本来就是笔记与待办共用的一套。

        since 是调用方「已应用到第几号」：别的设备只发序号不晚于它的 ID，
        那些设备肯定已经重放过那条删除，不会出现刚用回收的 ID 建的条目
        被自己还没拉到的删除又擦掉；发起删除的那一台不必等序号，
        它本地那份早就删掉了，删完就能直接把 ID 拿去新建。
        没发出去的条数当 pending 报回去，客户端同步一次之后再来取就有了。"""
        count = max(1, min(int(count), RECYCLE_CLAIM_MAX))
        device = str(device or "")
        with self.lock:
            pool = self._recyclable()
            if kind:
                same_kind = [item for item in pool if item["kind"] == kind]
                if same_kind:
                    pool = same_kind
            if since is None:
                ready = pool
            else:
                ready = [item for item in pool
                         if item["seq"] <= int(since) or (device and item["device"] == device)]
            picked = ready[:count]
            until = now_ms() + RECYCLE_HOLD_SECONDS * 1000
            for item in picked:
                self.holds[item["path"]] = {"device": device, "until": until}
            return picked, len(pool) - len(picked)

    def state(self):
        with self.lock:
            return {
                "latestSeq": self.latest_seq,
                "count": self.count,
                "files": dict(self.files),
                "deleted": dict(self.deleted),
                # 删除腾出来的、能给新建条目再用的 ID 有多少个
                "recyclable": len(self._recyclable()),
            }

    def summary(self):
        exists = os.path.isfile(self.path)
        size = 0
        updated_at = 0
        if exists:
            try:
                info = os.stat(self.path)
                size = int(info.st_size)
                updated_at = int(info.st_mtime * 1000)
            except OSError:
                size = 0
                updated_at = 0
        with self.lock:
            recyclable = len(self._recyclable())
        return {
            "journalId": self.journal_id,
            "latestSeq": self.latest_seq,
            "ops": self.count,
            "files": len(self.files),
            "deleted": len(self.deleted),
            "recyclable": recyclable,
            "size": size,
            "updatedAt": updated_at,
            "exists": exists,
        }


MANAGER_DIR_NAME = "manager"
WEB_DIR_NAME = "web"
INDEX_NAME = "index.html"
ASSET_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}

MISSING_PAGE_HTML = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>缺少页面文件</title></head>
<body style="font:14px/1.7 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;padding:40px;background:#0d1117;color:#f0f6fc">
<h1 style="font-size:18px;margin-bottom:12px">找不到{title}的页面文件</h1>
<p style="color:#8b949e">服务端读取入口页面的位置：</p>
<p><code style="background:#21262d;padding:6px 10px;border-radius:6px;display:inline-block">{path}</code></p>
</body></html>
"""


def manager_dir():
    return os.path.join(SCRIPT_DIR, MANAGER_DIR_NAME)


def web_dir():
    return os.path.join(SCRIPT_DIR, WEB_DIR_NAME)


def read_index_html(root, title):
    path = os.path.join(root, INDEX_NAME)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return MISSING_PAGE_HTML.replace("{title}", title).replace("{path}", path)


def read_manager_index():
    return read_index_html(manager_dir(), "管理后台")


def read_web_index():
    return read_index_html(web_dir(), "网页版客户端")


class ApiHandler(BaseHTTPRequestHandler):
    server_version = f"{SERVER_NAME}/{SERVER_VERSION}"
    protocol_version = "HTTP/1.1"

    users = None
    token = ""

    def log_message(self, fmt, *args):
        log("INFO", "HTTP", "{} {}".format(self.log_date_time_string(), fmt % args))

    def _send(self, status, payload=None, raw=None, content_type="application/json; charset=utf-8", extra_headers=None):
        body = raw if raw is not None else json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _cookie_value(self, name):
        raw = self.headers.get("Cookie", "")
        for part in raw.split(";"):
            if "=" not in part:
                continue
            key, value = part.split("=", 1)
            if key.strip() == name:
                return value.strip()
        return ""

    def _session_id(self):
        return self._cookie_value(ADMIN_COOKIE_NAME)

    def _current_user(self):
        """当前登录会话对应的账户；未登录、会话过期、账户已停用都返回 None。"""
        session_id = self._session_id()
        if not session_id:
            return None
        user, _session = self.users.session_user(session_id)
        return user

    def _journal_for(self, user_id):
        return self.users.journal(user_id)

    def _session_cookie(self, session_id):
        return "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}".format(
            ADMIN_COOKIE_NAME, session_id, SESSION_TTL_SECONDS)

    def _expired_cookie(self):
        return "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0".format(ADMIN_COOKIE_NAME)

    def _client_ip(self):
        return self.client_address[0] if self.client_address else ""

    # 同源判定：Origin 存在时必须与请求的 Host 一致（跨站请求即使带上 Cookie 也在这里被挡下）。
    # 同源 GET 一般不携带 Origin，此时交给 SameSite=Lax 的 Cookie 策略兜底：
    # 跨站 POST 不会带上登录态，而读取类接口都是 GET，没有副作用。
    def _is_same_origin(self):
        origin = self.headers.get("Origin", "")
        if not origin:
            return True
        parsed_origin = urlparse(origin)
        return bool(parsed_origin.netloc) and parsed_origin.netloc == self.headers.get("Host", "")

    # 静态资源：相对路径先归一化，再确认落在指定根目录内，避免穿越到目录之外
    def _send_static_asset(self, root, relative, fallback_name=""):
        relative = str(relative or fallback_name).lstrip("/")
        target = os.path.abspath(os.path.join(root, relative))
        if not target.startswith(root + os.sep) or not os.path.isfile(target):
            self._send(404, {"ok": False, "error": "找不到文件"})
            return

        try:
            with open(target, "rb") as handle:
                body = handle.read()
        except OSError as error:
            log("ERROR", "Static", "读取失败: {} (path={})".format(error, target))
            self._send(500, {"ok": False, "error": "读取失败"})
            return

        extension = os.path.splitext(target)[1].lower()
        self._send(200, raw=body,
                   content_type=ASSET_CONTENT_TYPES.get(extension, "application/octet-stream"),
                   extra_headers={"Cache-Control": "no-store"})

    def _send_manager_asset(self, path):
        self._send_static_asset(manager_dir(), path, INDEX_NAME)

    def _send_web_asset(self, path):
        self._send_static_asset(web_dir(), path, INDEX_NAME)

    def _send_journal_attachment(self, journal):
        target = journal.path
        if not os.path.isfile(target):
            self._send(404, {"ok": False, "error": "日志文件还不存在：该账户还没有同步过任何内容"})
            return

        try:
            size = os.path.getsize(target)
            handle = open(target, "rb")
        except OSError as error:
            log("ERROR", "Journal", "读取失败: {} (path={})".format(error, target))
            self._send(500, {"ok": False, "error": "读取日志失败"})
            return

        with handle:
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition",
                             'attachment; filename="{}"'.format(journal_download_name()))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

            remaining = size
            while remaining > 0:
                chunk = handle.read(min(262144, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _authorize_api(self):
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            value = header[7:].strip()

            if self.token and hmac.compare_digest(value, self.token):
                return {"id": "", "name": "启动参数 --token", "device": "", "builtin": True,
                        "userId": DEFAULT_ACCOUNT_ID}, ""

            user_id, record = self.users.find_token_by_plain(value)
            if not record:
                return None, "令牌无效（请在管理后台确认，或看看是不是刚重置过）"
            if not record.get("enabled", True):
                return None, "该令牌已在管理后台停用"
            user = self.users.find_user(user_id)
            if not user or not user["enabled"]:
                return None, "该令牌所属的账户已停用"
            # record 是存储里的那份记录本身：记「最近使用」时要就地改它
            return {"id": record["id"], "name": record.get("name", ""), "device": record.get("device", ""),
                    "builtin": False, "userId": user_id, "userName": user["name"], "record": record}, ""

        # 同源请求：认登录会话（就在本服务端登录，同源页面可直接读写同步接口）。
        # 未配置任何凭据时不再放行：读写一律要求登录会话或访问令牌
        if self._is_same_origin():
            user = self._current_user()
            if user:
                return {"id": "", "name": "登录会话 {}".format(user["name"]), "device": "",
                        "builtin": False, "userId": user["id"], "userName": user["name"]}, ""

        return None, "缺少凭据（请先登录，客户端请在设置里填写访问令牌）"

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 32 * 1024 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)

        if parsed.path == SYNC_PATH + "/health":
            # 不带凭据时只报服务端身份（同步相关的两项留空）：健康检查不该泄露任何一个账户的规模。
            # 带凭据时补上该凭据所属账户的日志身份，客户端靠它发现日志被换过。
            payload = {
                "ok": True,
                "name": SERVER_NAME,
                "version": SERVER_VERSION,
                "journalId": "",
                "latestSeq": 0,
                "account": "",
                "authRequired": True,
                "syncPath": SYNC_PATH,
                "webPath": "/",
                "adminPath": ADMIN_PATH,
            }
            record, _error = self._authorize_api()
            if record:
                journal = self._journal_for(record["userId"])
                payload["journalId"] = journal.journal_id
                payload["latestSeq"] = journal.latest_seq
                payload["account"] = record.get("userName") or DEFAULT_ACCOUNT_NAME
            self._send(200, payload)
            return

        if parsed.path == HEALTH_PATH:
            self._send(200, {
                "ok": True,
                "name": SERVER_NAME,
                "version": SERVER_VERSION,
                "syncPath": SYNC_PATH,
                "webPath": "/",
                "adminPath": ADMIN_PATH,
                "apiPath": API_PREFIX,
                "passwordSet": self.users.password_set(),
                "tokenCount": self.users.token_count(),
                "accountCount": len(self.users.users),
                "defaultAccount": DEFAULT_ACCOUNT_NAME,
                "authRequired": True,
            })
            return

        # 网页版客户端：根路径返回页面，页面资源（样式、脚本、图标、字体）按白名单从 web/ 目录取
        if parsed.path in ("/", "/index.html"):
            page = read_web_index()
            self._send(200, raw=page.encode("utf-8"), content_type="text/html; charset=utf-8",
                       extra_headers={"Cache-Control": "no-store"})
            return

        if parsed.path in WEB_ASSET_PATHS or parsed.path.startswith(WEB_ASSET_PREFIXES):
            self._send_web_asset(parsed.path)
            return

        # 管理接口：/admin/api/*
        if parsed.path.startswith(API_PREFIX + "/"):
            self._handle_admin_get(parsed.path, query)
            return

        # 管理页：/admin 返回页面，页面资源（样式、脚本、图标、字体）也从它下面取
        if parsed.path == ADMIN_PATH or parsed.path.startswith(ADMIN_PATH + "/"):
            rest = parsed.path[len(ADMIN_PATH):]
            if rest in ("", "/", "/" + INDEX_NAME):
                page = read_manager_index()
                self._send(200, raw=page.encode("utf-8"), content_type="text/html; charset=utf-8",
                           extra_headers={"Cache-Control": "no-store"})
                return
            if rest in MANAGER_ASSET_PATHS or rest.startswith(MANAGER_ASSET_PREFIXES):
                self._send_manager_asset(rest)
                return
            self._send(404, {"ok": False, "error": "找不到文件"})
            return

        record, error = self._authorize_api()
        if not record:
            self._send(401, {"ok": False, "error": error})
            return

        # 下面这一段是同步接口：一律作用在当前凭据所属账户的那份日志上
        journal = self._journal_for(record["userId"])

        if parsed.path == SYNC_PATH + "/ops":
            since = int((query.get("since") or ["0"])[0] or 0)
            limit = int((query.get("limit") or [str(DEFAULT_PAGE_LIMIT)])[0] or DEFAULT_PAGE_LIMIT)
            limit = max(1, min(limit, MAX_PAGE_LIMIT))
            ops = journal.read_ops(since, limit)
            self._send(200, {
                "ok": True,
                "latestSeq": journal.latest_seq,
                "ops": ops,
                "hasMore": bool(ops) and ops[-1]["seq"] < journal.latest_seq,
            })
            return

        # 可复用 ID：被删除的条目腾出来的 ID（最近删掉的排在前面），供新建的条目领取
        if parsed.path == SYNC_PATH + "/ids":
            limit = parse_int((query.get("limit") or [""])[0], RECYCLE_POOL_LIMIT, 1, RECYCLE_POOL_LIMIT)
            pool = journal.recyclable(limit)
            self._send(200, {"ok": True, "count": len(pool), "ids": pool})
            return

        if parsed.path == SYNC_PATH + "/state":
            state = journal.state()
            state["ok"] = True
            state["journalId"] = journal.journal_id
            self._send(200, state)
            return

        if parsed.path == SYNC_PATH + "/file":
            path = normalize_relative_path((query.get("path") or [""])[0])
            if not path:
                self._send(400, {"ok": False, "error": "路径不合法"})
                return
            entry = journal.read_file(path)
            if not entry:
                self._send(404, {"ok": False, "error": "没有该文件（可能已被删除）"})
                return
            self._send(200, {
                "ok": True,
                "path": path,
                "hash": entry.get("hash", ""),
                "encoding": entry.get("encoding", "utf8"),
                "data": entry.get("data", ""),
                "seq": entry.get("seq", 0),
            })
            return

        self._send(404, {"ok": False, "error": "未知接口"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith(API_PREFIX + "/"):
            payload = self._read_json() or {}
            self._handle_admin_post(parsed.path, payload)
            return

        record, error = self._authorize_api()
        if not record:
            self._send(401, {"ok": False, "error": error})
            return

        # 同步接口一律作用在当前凭据所属账户的那份日志上
        journal = self._journal_for(record["userId"])

        if parsed.path == SYNC_PATH + "/ops":
            payload = self._read_json()
            if not payload or not isinstance(payload.get("ops"), list):
                self._send(400, {"ok": False, "error": "请求体需要 {device, ops:[...]}"})
                return
            if not payload["ops"]:
                self._send(200, {"ok": True, "latestSeq": journal.latest_seq, "accepted": []})
                return

            bound_device = str(record.get("device") or "")
            device = bound_device or str(payload.get("device") or "")
            if bound_device:
                for raw in payload["ops"]:
                    if isinstance(raw, dict):
                        raw.pop("device", None)
            accepted = journal.append_many(device, payload["ops"])
            if record.get("record"):
                self.users.note_token_use(record["userId"], record["record"], str(payload.get("device") or ""))

            # 彻底删除（del）之后，这条路径的正文历史不必再留在日志里：只留那一条删除标记
            deleted_paths = [raw.get("path") for raw in payload["ops"]
                             if isinstance(raw, dict) and raw.get("op") == "del"]
            if deleted_paths:
                compacted = journal.compact(deleted_paths)
                if compacted["removed"]:
                    log("INFO", "Journal", "彻底删除后整理日志: 抹掉 {} 行，保留 {} 行 (account={})".format(
                        compacted["removed"], compacted["kept"], record["userId"]))

            rejected = [item for item in accepted if item.get("error")]
            self._send(200, {
                "ok": not rejected,
                "error": rejected[0]["error"] if rejected else "",
                "latestSeq": journal.latest_seq,
                "accepted": accepted,
            })
            return

        # 新建条目时领一个可复用的 ID：服务端把领走的占住一会儿，
        # 免得两台设备同时新建时拿到同一个 ID（占位在条目被创建或超时后失效）
        if parsed.path == SYNC_PATH + "/ids/claim":
            payload = self._read_json() or {}
            if not isinstance(payload, dict):
                payload = {}
            kind = str(payload.get("kind") or "")
            if kind not in ("notes", "todos"):
                kind = ""
            count = parse_int(payload.get("count"), 1, 1, RECYCLE_CLAIM_MAX)
            # since 缺省时不筛：只发该设备确认已经重放过删除的那些 ID（不过滤则全部可领）
            since = payload.get("since")
            if since is not None:
                since = parse_int(since, 0, 0, 2 ** 62)
            device = str(payload.get("device") or record.get("device") or "")
            picked, pending = journal.claim_recyclable(device, kind, count, since)
            self._send(200, {"ok": True, "count": len(picked), "pending": pending, "ids": picked})
            return

        self._send(404, {"ok": False, "error": "未知接口"})

    # ---------------- 管理接口 ----------------
    # 除 status / login / logout / 改自己的密码之外，一律要求管理员账户

    def _admin_guard(self):
        """已登录且是管理员时返回账户，否则自行作答并返回 None。"""
        user = self._current_user()
        if not user:
            self._send(401, {"ok": False, "error": "请先登录管理后台"})
            return None
        if not user["admin"]:
            self._send(403, {"ok": False, "error": "该账户没有管理权限"})
            return None
        return user

    def _resolve_account(self, raw, fallback):
        """管理接口里指定的账户：空值表示调用者自己；返回 (账户 id, 错误)。"""
        text = str(raw or "").strip()
        if not text:
            return fallback, ""
        user = self.users.find_user(text) or self.users.find_user_by_name(text)
        if not user:
            return None, "找不到该账户"
        return user["id"], ""

    def _handle_admin_get(self, path, query):
        if path == API_PREFIX + "/status":
            user = self._current_user()
            self._send(200, {
                "ok": True,
                "version": SERVER_VERSION,
                "passwordSet": self.users.password_set(),
                "loggedIn": bool(user),
                "admin": bool(user and user["admin"]),
                "user": {"id": user["id"], "name": user["name"], "admin": bool(user["admin"])} if user else None,
                "accountCount": len(self.users.users),
                "tokenCount": self.users.token_count(),
            })
            return

        current = self._admin_guard()
        if not current:
            return

        account = (query.get("user") or [""])[0]

        if path == API_PREFIX + "/users":
            self._send(200, {"ok": True, "users": self.users.list_users()})
            return

        if path == API_PREFIX + "/tokens":
            user_id, error = self._resolve_account(account, current["id"])
            if not user_id:
                self._send(404, {"ok": False, "error": error})
                return
            self._send(200, {"ok": True, "user": user_id, "tokens": self.users.list_tokens(user_id)})
            return

        if path == API_PREFIX + "/journal":
            user_id, error = self._resolve_account(account, current["id"])
            if not user_id:
                self._send(404, {"ok": False, "error": error})
                return
            payload = self.users.journal(user_id).summary()
            payload["ok"] = True
            payload["user"] = user_id
            self._send(200, payload)
            return

        if path == API_PREFIX + "/journal/download":
            user_id, error = self._resolve_account(account, current["id"])
            if not user_id:
                self._send(404, {"ok": False, "error": error})
                return
            self._send_journal_attachment(self.users.journal(user_id))
            return

        self._send(404, {"ok": False, "error": "未知接口"})

    def _handle_admin_post(self, path, payload):
        if path == API_PREFIX + "/setup-password":
            password = str(payload.get("password") or "")
            if len(password) < MIN_PASSWORD_LENGTH:
                self._send(400, {"ok": False, "error": "密码至少 {} 位".format(MIN_PASSWORD_LENGTH)})
                return
            if not self.users.set_password(password):
                self._send(400, {"ok": False, "error": "管理密码已经设置过了，请用现有密码登录"})
                return
            session_id = self.users.create_session(DEFAULT_ACCOUNT_ID, self._client_ip())
            log("INFO", "Auth", "内置账户已设密码: name={}".format(DEFAULT_ACCOUNT_NAME))
            self._send(200, {"ok": True}, extra_headers={"Set-Cookie": self._session_cookie(session_id)})
            return

        if path == API_PREFIX + "/login":
            ip = self._client_ip()
            if not self.users.login_allowed(ip):
                self._send(429, {"ok": False, "error": "尝试次数过多，请稍后再试"})
                return
            user, error = self.users.authenticate(
                str(payload.get("name") or ""), str(payload.get("password") or ""))
            if not user:
                self.users.note_login_failure(ip)
                self._send(401, {"ok": False, "error": error})
                return
            # 管理后台只允许管理员登录；网页版客户端走同一个接口，用 requireAdmin 区分
            if payload.get("requireAdmin") and not user["admin"]:
                self._send(403, {"ok": False, "error": "该账户不是管理员，无法进入管理后台"})
                return
            session_id = self.users.create_session(user["id"], ip)
            log("INFO", "Auth", "登录成功: name={} admin={} ip={}".format(user["name"], user["admin"], ip))
            self._send(200, {
                "ok": True,
                "user": {"id": user["id"], "name": user["name"], "admin": bool(user["admin"])},
            }, extra_headers={"Set-Cookie": self._session_cookie(session_id)})
            return

        current = self._current_user()
        if not current:
            self._send(401, {"ok": False, "error": "请先登录"})
            return

        if path == API_PREFIX + "/logout":
            self.users.destroy_session(self._session_id())
            self._send(200, {"ok": True}, extra_headers={"Set-Cookie": self._expired_cookie()})
            return

        # 改自己的密码：任何已登录账户都能改
        if path == API_PREFIX + "/password":
            new_password = str(payload.get("newPassword") or "")
            if len(new_password) < MIN_PASSWORD_LENGTH:
                self._send(400, {"ok": False, "error": "新密码至少 {} 位".format(MIN_PASSWORD_LENGTH)})
                return
            if not self.users.change_password(current["id"], str(payload.get("oldPassword") or ""), new_password):
                self._send(400, {"ok": False, "error": "当前密码不正确"})
                return
            session_id = self.users.create_session(current["id"], self._client_ip())
            self._send(200, {"ok": True}, extra_headers={"Set-Cookie": self._session_cookie(session_id)})
            return

        # 以下都只有管理员能做
        if not current["admin"]:
            self._send(403, {"ok": False, "error": "该账户没有管理权限"})
            return

        if path == API_PREFIX + "/users/create":
            record, error = self.users.create_user(
                payload.get("name"), payload.get("password"), bool(payload.get("admin")))
            if not record:
                self._send(400, {"ok": False, "error": error})
                return
            self._send(200, {"ok": True, "user": record, "users": self.users.list_users()})
            return

        if path == API_PREFIX + "/users/update":
            record, error = self.users.update_user(
                str(payload.get("id") or ""), payload.get("name"), payload.get("enabled"), payload.get("admin"))
            if not record:
                self._send(400, {"ok": False, "error": error})
                return
            self._send(200, {"ok": True, "user": record, "users": self.users.list_users()})
            return

        if path == API_PREFIX + "/users/password":
            reset, error = self.users.reset_password(str(payload.get("id") or ""), payload.get("password"))
            if not reset:
                self._send(400, {"ok": False, "error": error})
                return
            self._send(200, {"ok": True, "users": self.users.list_users()})
            return

        if path == API_PREFIX + "/users/delete":
            removed, error = self.users.delete_user(str(payload.get("id") or ""))
            if not removed:
                self._send(400, {"ok": False, "error": error})
                return
            self._send(200, {"ok": True, "users": self.users.list_users()})
            return

        # 令牌与日志都以某个账户为对象，缺省即管理员自己
        user_id, error = self._resolve_account(payload.get("user"), current["id"])
        if not user_id:
            self._send(404, {"ok": False, "error": error})
            return

        if path == API_PREFIX + "/tokens":
            token_id, token = self.users.create_token(user_id, payload.get("name"), payload.get("device"))
            self._send(200, {
                "ok": True,
                "id": token_id,
                "token": token,
                "user": user_id,
                "tokens": self.users.list_tokens(user_id),
            })
            return

        if path == API_PREFIX + "/tokens/rotate":
            token = self.users.rotate_token(user_id, str(payload.get("id") or ""))
            if not token:
                self._send(404, {"ok": False, "error": "找不到该令牌"})
                return
            self._send(200, {"ok": True, "token": token, "tokens": self.users.list_tokens(user_id)})
            return

        if path == API_PREFIX + "/tokens/update":
            record = self.users.update_token(
                user_id, str(payload.get("id") or ""), payload.get("name"),
                payload.get("device"), payload.get("enabled"))
            if not record:
                self._send(404, {"ok": False, "error": "找不到该令牌"})
                return
            self._send(200, {"ok": True, "tokens": self.users.list_tokens(user_id)})
            return

        if path == API_PREFIX + "/tokens/delete":
            if not self.users.delete_token(user_id, str(payload.get("id") or "")):
                self._send(404, {"ok": False, "error": "找不到该令牌"})
                return
            self._send(200, {"ok": True, "tokens": self.users.list_tokens(user_id)})
            return

        # 整理日志：把已彻底删除的路径的正文历史抹掉，只留删除标记（序号不变）
        if path == API_PREFIX + "/journal/compact":
            compacted = self.users.journal(user_id).compact()
            compacted["ok"] = True
            compacted["user"] = user_id
            compacted["journal"] = self.users.journal(user_id).summary()
            self._send(200, compacted)
            return

        self._send(404, {"ok": False, "error": "未知接口"})


def create_server(host, port, data_dir, token):
    users = UserStore(data_dir)
    handler = type("BoundApiHandler", (ApiHandler,), {"users": users, "token": token})
    httpd = ThreadingHTTPServer((host, port), handler)
    return httpd, users


def selftest():
    import json as _json
    import tempfile
    import urllib.request
    import urllib.error

    passed = 0
    failures = []

    def check(name, condition, detail=""):
        nonlocal passed
        if condition:
            passed += 1
            log("INFO", "Selftest", "用例通过: {}".format(name))
        else:
            failures.append(name)
            log("ERROR", "Selftest", "用例失败: {} (detail={})".format(name, detail))

    with tempfile.TemporaryDirectory() as tmp:
        data_dir = os.path.join(tmp, "data")
        httpd, users = create_server("127.0.0.1", 0, data_dir, "secret")
        journal = users.journal(DEFAULT_ACCOUNT_ID)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{port}"
        cookies = {}

        def _absorb(response):
            value = response.headers.get("Set-Cookie")
            if not value:
                return
            pair = value.split(";", 1)[0]
            if "=" not in pair:
                return
            key, name = pair.split("=", 1)
            if name.strip():
                cookies[key.strip()] = name.strip()
            else:
                cookies.pop(key.strip(), None)

        def call(method, path, payload=None, token=None, use_cookie=False, origin=None):
            data = None
            headers = {}
            if payload is not None:
                data = _json.dumps(payload).encode("utf-8")
                headers["Content-Type"] = "application/json"
            if origin:
                headers["Origin"] = origin
            request = urllib.request.Request(base + path, data=data, headers=headers, method=method)
            if token is not None:
                request.add_header("Authorization", "Bearer " + token)
            if use_cookie and cookies:
                request.add_header("Cookie", "; ".join(f"{key}={value}" for key, value in cookies.items()))
            try:
                with urllib.request.urlopen(request, timeout=5) as response:
                    body = response.read().decode("utf-8")
                    _absorb(response)
                    return response.status, (_json.loads(body) if body.strip().startswith(("{", "[")) else {"_raw": body})
            except urllib.error.HTTPError as error:
                body = error.read().decode("utf-8")
                _absorb(error)
                try:
                    parsed = _json.loads(body) if body.strip() else {}
                except ValueError:
                    parsed = {"_raw": body}
                return error.code, parsed

        def get(path, token="secret", cookie=False, origin=None):
            return call("GET", path, token=token, use_cookie=cookie, origin=origin)

        def post(path, payload, token="secret", cookie=False, origin=None):
            return call("POST", path, payload, token=token, use_cookie=cookie, origin=origin)

        def download(path, cookie=True):
            request = urllib.request.Request(base + path, method="GET")
            if cookie and cookies:
                request.add_header("Cookie", "; ".join(f"{key}={value}" for key, value in cookies.items()))
            try:
                with urllib.request.urlopen(request, timeout=5) as response:
                    return response.status, response.headers, response.read().decode("utf-8")
            except urllib.error.HTTPError as error:
                return error.code, error.headers, error.read().decode("utf-8")

        sync = SYNC_PATH

        log("INFO", "Selftest", "section=config")
        config_file = os.path.join(tmp, CONFIG_NAME)
        with open(config_file, "w", encoding="utf-8") as handle:
            handle.write('{"host": "0.0.0.0", "port": 4936}')
        check("优先用数据目录里的 config.json", config_path(tmp) == config_file, config_path(tmp))
        check("从 config.json 读地址与端口", read_config(tmp) == {"port": 4936, "host": "0.0.0.0"}, repr(read_config(tmp)))
        with open(config_file, "w", encoding="utf-8") as handle:
            handle.write('{"host": "  ", "port": "abc"}')
        check("地址为空、端口不是数字时都忽略", read_config(tmp) == {}, repr(read_config(tmp)))
        with open(config_file, "w", encoding="utf-8") as handle:
            handle.write('{"port": 70000}')
        check("端口超出范围时忽略", read_config(tmp) == {}, repr(read_config(tmp)))
        with open(config_file, "w", encoding="utf-8") as handle:
            handle.write('not json')
        check("config.json 不是 JSON 时忽略", read_config(tmp) == {}, repr(read_config(tmp)))
        os.remove(config_file)

        log("INFO", "Selftest", "section=api")
        status, health = get(sync + "/health", token=None)
        check("health 不需要令牌", status == 200 and health.get("latestSeq") == 0, repr(health))
        check("health 标明需要令牌", health.get("authRequired") is True)
        check("不带凭据的 health 不报日志身份",
              health.get("journalId") == "" and health.get("account") == "", repr(health))
        status, health = get(sync + "/health", token="secret")
        check("带凭据的 health 带回日志身份与账户名",
              isinstance(health.get("journalId"), str) and len(health["journalId"]) > 0
              and health.get("account") == DEFAULT_ACCOUNT_NAME, repr(health))
        check("health 告知同步接口前缀", health.get("syncPath") == SYNC_PATH, repr(health.get("syncPath")))

        status, _ = get(sync + "/ops?since=0", token=None)
        check("缺令牌时 401", status == 401)
        status, _ = get(sync + "/ops?since=0", token="wrong")
        check("令牌错误时 401", status == 401)

        status, body = post(sync + "/ops", {
            "device": "dev-a",
            "ops": [
                {"opId": "a-1", "op": "put", "path": "notes/one.md", "data": "第一篇", "hash": sha256_text("第一篇"), "time": 1000},
                {"opId": "a-2", "op": "put", "path": "notes/two.md", "data": "第二篇", "hash": sha256_text("第二篇"), "time": 1001},
                {"opId": "a-3", "op": "del", "path": "notes/two.md", "time": 1002},
            ],
        })
        check("追加三条操作", status == 200 and [item["seq"] for item in body["accepted"]] == [1, 2, 3], repr(body))

        status, body = post(sync + "/ops", {
            "device": "dev-a",
            "ops": [{"opId": "a-3", "op": "del", "path": "notes/two.md", "time": 1002}],
        })
        check("重复提交同一条 opId 不重复写", body["accepted"][0].get("duplicate") is True and body["latestSeq"] == 3, repr(body))

        status, body = get(sync + "/ops?since=0")
        check("拉取全部操作", len(body["ops"]) == 2 and [item["seq"] for item in body["ops"]] == [1, 3],
              repr(body)[:200])
        check("彻底删除之后：日志里不再留它的正文，只剩一条删除标记",
              body["ops"][-1]["op"] == "del" and "data" not in body["ops"][-1]
              and all(item["path"] != "notes/two.md" or item["op"] == "del" for item in body["ops"]),
              repr(body["ops"])[:200])

        # 被抹掉的那条 put 的操作号记在删除标记上：断线重试同一个 opId 仍然算「收过」，不会把内容写回来
        status, body = post(sync + "/ops", {
            "device": "dev-a",
            "ops": [{"opId": "a-2", "op": "put", "path": "notes/two.md", "data": "第二篇",
                     "hash": sha256_text("第二篇"), "time": 1001}],
        })
        check("整理日志之后，重试被抹掉的那条操作仍然算重复",
              status == 200 and body["accepted"][0].get("duplicate") is True and body["latestSeq"] == 3,
              repr(body))
        status, body = get(sync + "/state")
        check("重试被抹掉的操作不会把已删除的文件写回来",
              "notes/two.md" not in body["files"] and body["deleted"].get("notes/two.md") == 3, repr(body))

        status, body = get(sync + "/ops?since=2")
        check("since 之后只回传新操作", [item["seq"] for item in body["ops"]] == [3], repr(body))

        status, body = get(sync + "/state")
        check("state 里只留存活文件", list(body["files"].keys()) == ["notes/one.md"], repr(body["files"]))
        check("state 里保留删除记录", body["deleted"].get("notes/two.md") == 3, repr(body["deleted"]))
        check("state 报出可复用 ID 的数量", body.get("recyclable") == 1, repr(body.get("recyclable")))

        status, body = get(sync + "/ids")
        check("可复用 ID 就是刚被删掉的那一条",
              status == 200 and body.get("count") == 1 and [item["id"] for item in body["ids"]] == ["two"],
              repr(body))

        status, body = post(sync + "/ids/claim", {"device": "dev-b", "kind": "notes", "count": 1, "since": 3})
        check("新建条目时能领回被删掉的 ID",
              status == 200 and [item["id"] for item in body["ids"]] == ["two"], repr(body))

        status, body = post(sync + "/ids/claim", {"device": "dev-c", "kind": "notes", "count": 1, "since": 3})
        check("已领走的 ID 不会同时发给另一台设备", status == 200 and body["ids"] == [], repr(body))

        status, body = post(sync + "/ids/claim", {"device": "dev-d", "kind": "notes", "count": 1, "since": 2})
        check("序号还没跟上的设备先不发，并把它当成待同步",
              status == 200 and body["ids"] == [] and body["pending"] == 1, repr(body))

        status, body = get(sync + "/file?path=notes/one.md")
        check("能重放出文件内容", status == 200 and body["data"] == "第一篇", repr(body))
        status, body = get(sync + "/file?path=notes/two.md")
        check("已删除的文件查不到", status == 404, repr(body))

        status, body = post(sync + "/ops", {"device": "dev-a", "ops": [{"op": "put", "path": "../evil.md", "data": "x"}]})
        check("越界路径被拒绝", body["ok"] is False and "路径不合法" in body.get("error", ""), repr(body))

        log("INFO", "Selftest", "section=admin")
        status, page = get("/", token=None)
        check("根路径返回网页版客户端", status == 200 and "EsprinNemo" in page.get("_raw", ""), repr(page)[:160])

        status, page = get("/index.html", token=None)
        check("网页版也能按 /index.html 打开", status == 200 and "<!DOCTYPE html>" in page.get("_raw", ""), repr(page)[:160])

        status, css = get("/styles/tokens.css", token=None)
        check("网页版样式可直接取用", status == 200 and "--bg-body" in css.get("_raw", ""), repr(css)[:80])

        status, body = get("/scripts/app.js", token=None)
        check("网页版脚本可直接取用", status == 200 and "showConnectGate" in body.get("_raw", ""), repr(body)[:80])

        status, body = get("/styles/../../sync.py", token=None)
        check("网页版静态资源不允许穿越出 web 目录", status == 404, repr(body))

        status, body = get("/README.md", token=None)
        check("网页版目录里未列入白名单的文件不对外提供", status != 200, repr(body)[:80])

        status, page = get(ADMIN_PATH, token=None)
        check("/admin 返回管理页面", status == 200 and "EsprinSync" in page.get("_raw", ""), repr(page)[:160])

        status, page = get(ADMIN_PATH + "/index.html", token=None)
        check("管理页也能按 /admin/index.html 打开", status == 200 and "<!DOCTYPE html>" in page.get("_raw", ""), repr(page)[:160])

        status, page = get(ADMIN_PATH + "/", token=None)
        check("管理页收尾斜杠同样落到页面", status == 200 and "<!DOCTYPE html>" in page.get("_raw", ""), repr(page)[:160])

        status, css = get(ADMIN_PATH + "/app.css", token=None)
        check("管理页样式可直接取用", status == 200 and "--bg-body" in css.get("_raw", ""), repr(css)[:80])

        status, body = get(ADMIN_PATH + "/app.js", token=None)
        check("管理页脚本可直接取用", status == 200 and "API_BASE" in body.get("_raw", ""), repr(body)[:80])

        check("管理页字体随包提供",
              os.path.isfile(os.path.join(manager_dir(), "fonts", "Mohave-VariableFont_wght.ttf")), manager_dir())
        status, body = get(ADMIN_PATH + "/fonts/nope.ttf", token=None)
        check("字体目录里没有的文件返回 404", status == 404, repr(body))

        status, body = get(ADMIN_PATH + "/fonts/../../sync.py", token=None)
        check("静态资源不允许穿越出 manager 目录", status == 404, repr(body))

        status, body = get(ADMIN_PATH + "/nope.css", token=None)
        check("管理页目录里没有的文件返回 404", status == 404, repr(body))

        status, body = get(HEALTH_PATH, token=None)
        check("health 告知网页版与管理页入口及凭据状态",
              status == 200 and body.get("webPath") == "/" and body.get("adminPath") == ADMIN_PATH
              and body.get("apiPath") == API_PREFIX
              and body.get("passwordSet") is False and body.get("authRequired") is True, repr(body))

        status, body = get(sync + "/health", token=None)
        check("同步侧的 health 同样带出入口", body.get("adminPath") == ADMIN_PATH and body.get("webPath") == "/", repr(body))

        status, body = get(sync + "/state", token=None)
        check("未登录的同源请求仍然 401", status == 401, repr(body))

        status, body = get(API_PREFIX + "/status", token=None)
        check("初始状态：未设密码、未登录", status == 200 and body.get("passwordSet") is False and body.get("loggedIn") is False, repr(body))

        status, body = get(API_PREFIX + "/tokens", token=None)
        check("未登录不能看令牌", status == 401, repr(body))

        status, body = post(API_PREFIX + "/setup-password", {"password": "123"}, token=None, cookie=True)
        check("密码太短被拒绝", status == 400, repr(body))

        status, body = post(API_PREFIX + "/setup-password", {"password": "admin-pass-1"}, token=None, cookie=True)
        check("首次设置密码并自动登录", status == 200 and ADMIN_COOKIE_NAME in cookies, repr(body))

        status, body = post(API_PREFIX + "/setup-password", {"password": "another-pass"}, token=None)
        check("密码只能设置一次", status == 400, repr(body))

        status, body = get(API_PREFIX + "/tokens", token=None, cookie=True)
        check("登录后可以看令牌列表", status == 200 and body.get("tokens") == [], repr(body))

        status, body = get("/api/status", token=None, cookie=True)
        check("管理接口只认 /admin/api 前缀", status == 404, repr(body))

        status, body = get(API_PREFIX + "/journal", token=None)
        check("未登录不能看日志概览", status == 401, repr(body))

        status, body = get(API_PREFIX + "/journal", token=None, cookie=True)
        check("日志概览：操作数、存活文件与删除记录",
              status == 200 and body.get("ops") == 2 and body.get("files") == 1
              and body.get("deleted") == 1 and body.get("latestSeq") == 3
              and body.get("size") > 0 and body.get("exists") is True, repr(body))

        status, headers, _ = download(API_PREFIX + "/journal/download", cookie=False)
        check("未登录不能下载日志", status == 401, str(status))

        status, headers, text = download(API_PREFIX + "/journal/download")
        lines = [line for line in text.splitlines() if line.strip()]
        disposition = headers.get("Content-Disposition") or ""
        check("下载日志：附件名与内容都是完整的操作行",
              status == 200 and "attachment" in disposition and 'filename="esprin-journal-' in disposition
              and len(lines) == 2 and _json.loads(lines[-1]).get("seq") == 3, repr(text)[:160])

        status, body = get(sync + "/state", token=None, cookie=True)
        check("同源管理后台持登录态可读同步接口", status == 200 and "files" in body, repr(body)[:120])
        status, body = get(sync + "/state", token=None, cookie=True, origin="https://evil.example")
        check("跨站请求带登录态也不放行", status == 401, repr(body))
        status, body = get(HEALTH_PATH, token=None)
        check("设过密码后 health 标明需要鉴权", body.get("passwordSet") is True, repr(body))

        status, body = post(API_PREFIX + "/tokens", {"name": "台式机", "device": "dev-bound"}, token=None, cookie=True)
        token_a = body.get("token", "")
        check("创建令牌并返回一次明文", status == 200 and token_a.startswith("esn_") and len(body["tokens"]) == 1, repr(body)[:160])
        check("列表里不带摘要", "digest" not in body["tokens"][0], repr(body["tokens"][0]))

        reloaded = UserStore(data_dir)
        check("密码与令牌都已落盘",
              reloaded.password_set() and reloaded.token_count() == 1,
              f"{reloaded.password_set()}/{reloaded.token_count()}")

        status, body = post(sync + "/ops", {
            "device": "dev-lying",
            "ops": [{"opId": "b-1", "op": "put", "path": "notes/bound.md", "data": "绑定设备", "device": "dev-op-level", "hash": sha256_text("绑定设备"), "time": 2000}],
        }, token=token_a)
        check("管理后台的令牌能同步", status == 200 and body["accepted"][0].get("error") is None, repr(body))

        status, body = get(sync + "/ops?since=3", token=token_a)
        check("令牌绑定的设备优先于客户端自报", body["ops"][0]["device"] == "dev-bound", repr(body["ops"][0]))

        status, body = get(API_PREFIX + "/tokens", token=None, cookie=True)
        check("记下了最近的设备", body["tokens"][0].get("lastDeviceId") == "dev-lying" and body["tokens"][0].get("lastUsedAt", 0) > 0, repr(body["tokens"][0]))
        token_id = body["tokens"][0]["id"]

        status, body = post(API_PREFIX + "/tokens/update", {"id": token_id, "name": "笔记本", "device": "dev-new"}, token=None, cookie=True)
        check("修改名称与设备", status == 200 and body["tokens"][0]["name"] == "笔记本" and body["tokens"][0]["device"] == "dev-new", repr(body)[:160])

        status, body = post(API_PREFIX + "/tokens/update", {"id": token_id, "enabled": False}, token=None, cookie=True)
        status2, body2 = get(sync + "/ops?since=0", token=token_a)
        check("停用后令牌立刻失效", status == 200 and status2 == 401 and "停用" in body2.get("error", ""), repr(body2))

        status, body = post(API_PREFIX + "/tokens/rotate", {"id": token_id}, token=None, cookie=True)
        token_b = body.get("token", "")
        status2, _ = get(sync + "/ops?since=0", token=token_a)
        status3, _ = get(sync + "/ops?since=0", token=token_b)
        check("重置后旧令牌失效、新令牌可用", status == 200 and status2 == 401 and status3 == 200 and token_b != token_a, f"{status}/{status2}/{status3}")

        status, body = post(API_PREFIX + "/login", {"password": "wrong-pass"}, token=None)
        check("密码错误不能登录", status == 401, repr(body))

        old_cookie = cookies[ADMIN_COOKIE_NAME]
        status, body = post(API_PREFIX + "/password", {"oldPassword": "nope", "newPassword": "new-pass-12"}, token=None, cookie=True)
        check("当前密码不对时拒绝改密码", status == 400, repr(body))

        status, body = post(API_PREFIX + "/password", {"oldPassword": "admin-pass-1", "newPassword": "new-pass-12"}, token=None, cookie=True)
        check("改密码成功并换发会话", status == 200 and cookies[ADMIN_COOKIE_NAME] != old_cookie, repr(body))

        current_cookie = cookies[ADMIN_COOKIE_NAME]
        cookies[ADMIN_COOKIE_NAME] = old_cookie
        status, body = get(API_PREFIX + "/tokens", token=None, cookie=True)
        check("改密码后旧会话失效", status == 401, repr(body))
        cookies[ADMIN_COOKIE_NAME] = current_cookie

        status, body = post(API_PREFIX + "/login", {"password": "new-pass-12"}, token=None, cookie=True)
        check("新密码可以登录", status == 200, repr(body))

        status, body = post(API_PREFIX + "/tokens/delete", {"id": token_id}, token=None, cookie=True)
        status2, _ = get(sync + "/ops?since=0", token=token_b)
        check("删除令牌后立即失效", status == 200 and status2 == 401, f"{status}/{status2}")

        status, body = post(API_PREFIX + "/logout", {}, token=None, cookie=True)
        status2, _ = get(API_PREFIX + "/tokens", token=None, cookie=True)
        check("退出登录后会话失效", status == 200 and status2 == 401, f"{status}/{status2}")

        check("启动参数 --token 仍然可用", get(sync + "/ops?since=0")[0] == 200)

        log("INFO", "Selftest", "section=accounts")
        status, body = post(API_PREFIX + "/login",
                            {"name": DEFAULT_ACCOUNT_NAME, "password": "new-pass-12"}, token=None, cookie=True)
        check("重新登录管理后台", status == 200 and body.get("user", {}).get("admin") is True, repr(body))
        admin_cookie = cookies[ADMIN_COOKIE_NAME]

        status, body = get(API_PREFIX + "/users", token=None, cookie=True)
        check("默认只有内置账户一个",
              status == 200 and [item["name"] for item in body["users"]] == [DEFAULT_ACCOUNT_NAME]
              and body["users"][0]["builtIn"] is True, repr(body)[:200])
        status, body = get(API_PREFIX + "/users", token=None)
        check("未登录不能看账户列表", status == 401, repr(body))

        status, body = post(API_PREFIX + "/users/create",
                            {"name": "  ", "password": "alice-pass-1"}, token=None, cookie=True)
        check("账户名不能为空", status == 400, repr(body))
        status, body = post(API_PREFIX + "/users/create",
                            {"name": "alice", "password": "short"}, token=None, cookie=True)
        check("新账户密码太短被拒", status == 400, repr(body))
        status, body = post(API_PREFIX + "/users/create",
                            {"name": "alice", "password": "alice-pass-1"}, token=None, cookie=True)
        check("管理员新建账户",
              status == 200 and body["user"]["name"] == "alice" and body["user"]["admin"] is False
              and body["user"]["id"] == "alice", repr(body)[:200])
        check("新账户的目录已建好", os.path.isdir(users.user_dir("alice")), users.user_dir("alice"))
        status, body = post(API_PREFIX + "/users/create",
                            {"name": "ALICE", "password": "alice-pass-1"}, token=None, cookie=True)
        check("账户名不分大小写，重名被拒", status == 400 and "已存在" in body.get("error", ""), repr(body))

        status, body = post(API_PREFIX + "/users/delete", {"id": DEFAULT_ACCOUNT_ID}, token=None, cookie=True)
        check("内置账户不能删除", status == 400 and "不能删除" in body.get("error", ""), repr(body))
        status, body = post(API_PREFIX + "/users/update", {"id": DEFAULT_ACCOUNT_ID, "admin": False}, token=None, cookie=True)
        check("内置账户不能取消管理员", status == 400, repr(body))
        status, body = post(API_PREFIX + "/users/update", {"id": DEFAULT_ACCOUNT_ID, "enabled": False}, token=None, cookie=True)
        check("内置账户不能停用", status == 400, repr(body))
        status, body = post(API_PREFIX + "/users/update", {"id": DEFAULT_ACCOUNT_ID, "name": "root"}, token=None, cookie=True)
        check("内置账户不能改名", status == 400, repr(body))

        status, body = post(API_PREFIX + "/login",
                            {"name": "alice", "password": "alice-pass-1", "requireAdmin": True}, token=None)
        check("普通账户不能登管理后台", status == 403, repr(body))
        status, body = post(API_PREFIX + "/login", {"name": "alice", "password": "alice-pass-9"}, token=None)
        check("账户名或密码错误时给同一句提示",
              status == 401 and body.get("error") == "账户名或密码不正确", repr(body))
        cookies[ADMIN_COOKIE_NAME] = admin_cookie

        status, body = post(API_PREFIX + "/login",
                            {"name": "alice", "password": "alice-pass-1"}, token=None, cookie=True)
        alice_cookie = cookies[ADMIN_COOKIE_NAME]
        check("普通账户可从网页版客户端登录",
              status == 200 and body.get("user", {}).get("admin") is False, repr(body))
        check("换了账户就是另一个会话", alice_cookie != admin_cookie)

        status, body = get(API_PREFIX + "/users", token=None, cookie=True)
        check("普通账户不能管理账户", status == 403, repr(body))
        status, body = get(API_PREFIX + "/tokens", token=None, cookie=True)
        check("普通账户不能访问令牌接口", status == 403, repr(body))
        status, body = get(sync + "/state", token=None, cookie=True)
        check("普通账户看到的是自己那份日志",
              status == 200 and body["files"] == {} and body["latestSeq"] == 0, repr(body)[:160])
        status, body = post(sync + "/ops", {"device": "dev-alice", "ops": [
            {"opId": "al-1", "op": "put", "path": "notes/alice.md", "data": "alice 的一篇",
             "hash": sha256_text("alice 的一篇")},
        ]}, token=None, cookie=True)
        check("普通账户可以写自己的日志", status == 200 and body["accepted"][0].get("error") is None, repr(body))
        status, body = get(sync + "/state", token=None, cookie=True)
        check("写入落在自己的日志里", list(body["files"].keys()) == ["notes/alice.md"], repr(body["files"]))
        cookies[ADMIN_COOKIE_NAME] = admin_cookie
        status, body = get(sync + "/state", token=None, cookie=True)
        check("账户之间互不可见",
              "notes/alice.md" not in body["files"] and body["latestSeq"] == 4, repr(body["files"]))

        status, body = post(API_PREFIX + "/tokens",
                            {"user": "alice", "name": "手机", "device": "dev-phone"}, token=None, cookie=True)
        token_alice = body.get("token", "")
        check("给指定账户建令牌",
              status == 200 and token_alice.startswith("esn_") and body.get("user") == "alice", repr(body)[:160])
        status, body = get(API_PREFIX + "/tokens?user=alice", token=None, cookie=True)
        check("令牌按账户分开列出", status == 200 and len(body["tokens"]) == 1, repr(body)[:160])
        status, body = get(sync + "/state", token=token_alice)
        check("令牌读到的是它所属账户的日志",
              status == 200 and list(body["files"].keys()) == ["notes/alice.md"], repr(body["files"])[:160])
        status, body = get(HEALTH_PATH, token=None)
        check("health 报出账户数与默认账户名",
              body.get("accountCount") == 2 and body.get("defaultAccount") == DEFAULT_ACCOUNT_NAME, repr(body))
        status, body = get(API_PREFIX + "/journal?user=alice", token=None, cookie=True)
        check("可以按账户看日志概览",
              status == 200 and body.get("user") == "alice" and body.get("ops") == 1, repr(body)[:160])
        status, body = get(API_PREFIX + "/journal?user=nobody", token=None, cookie=True)
        check("指定不存在的账户时 404", status == 404, repr(body))
        status, headers, text = download(API_PREFIX + "/journal/download?user=alice")
        check("可以下载指定账户的日志", status == 200 and "alice 的一篇" in text, repr(text)[:160])

        status, body = post(API_PREFIX + "/users/update", {"id": "alice", "name": "Alice"}, token=None, cookie=True)
        check("账户改名", status == 200 and body["user"]["name"] == "Alice", repr(body)[:160])
        status, body = post(API_PREFIX + "/users/update", {"id": "alice", "name": DEFAULT_ACCOUNT_NAME}, token=None, cookie=True)
        check("改名时不能与已有账户重名", status == 400, repr(body))

        status, body = post(API_PREFIX + "/users/password", {"id": "alice", "password": "alice-pass-2"}, token=None, cookie=True)
        check("管理员重设账户密码", status == 200 and body["users"][1]["passwordSet"] is True, repr(body)[:160])
        cookies[ADMIN_COOKIE_NAME] = alice_cookie
        status, body = get(API_PREFIX + "/status", token=None, cookie=True)
        check("重设密码后该账户的旧会话失效", body.get("loggedIn") is False, repr(body))
        cookies[ADMIN_COOKIE_NAME] = admin_cookie

        status, body = post(API_PREFIX + "/users/update", {"id": "alice", "enabled": False}, token=None, cookie=True)
        check("停用账户", status == 200 and body["user"]["enabled"] is False, repr(body))
        status, body = get(sync + "/state", token=token_alice)
        check("账户停用后它的令牌一并失效",
              status == 401 and "停用" in body.get("error", ""), repr(body))
        status, body = post(API_PREFIX + "/login", {"name": "Alice", "password": "alice-pass-2"}, token=None)
        check("停用后不能登录", status == 401 and "停用" in body.get("error", ""), repr(body))
        status, body = post(API_PREFIX + "/users/update", {"id": "alice", "enabled": True}, token=None, cookie=True)
        check("重新启用账户", status == 200 and body["user"]["enabled"] is True, repr(body))
        status, body = get(sync + "/state", token=token_alice)
        check("启用后令牌恢复可用",
              status == 200 and list(body["files"].keys()) == ["notes/alice.md"], repr(body["files"])[:120])

        status, body = post(API_PREFIX + "/users/delete", {"id": "alice"}, token=None, cookie=True)
        check("删除账户",
              status == 200 and [item["id"] for item in body["users"]] == [DEFAULT_ACCOUNT_ID], repr(body)[:160])
        check("账户目录连同数据一起删除", not os.path.exists(users.user_dir("alice")), users.user_dir("alice"))
        status, body = get(sync + "/state", token=token_alice)
        check("账户被删后它的令牌失效", status == 401, repr(body))
        status, body = post(API_PREFIX + "/users/delete", {"id": "nobody"}, token=None, cookie=True)
        check("删除不存在的账户时 400", status == 400, repr(body))

        log("INFO", "Selftest", "section=forced-auth")
        strict_httpd, _ = create_server("127.0.0.1", 0, os.path.join(tmp, "strict-data"), "")
        strict_port = strict_httpd.server_address[1]
        threading.Thread(target=strict_httpd.serve_forever, daemon=True).start()
        strict_base = f"http://127.0.0.1:{strict_port}"
        try:
            with urllib.request.urlopen(strict_base + HEALTH_PATH, timeout=5) as response:
                strict_health = _json.loads(response.read().decode("utf-8"))
            check("未配置凭据时 health 仍然声明需要鉴权",
                  strict_health.get("authRequired") is True and strict_health.get("passwordSet") is False
                  and strict_health.get("tokenCount") == 0, repr(strict_health))

            strict_status = 0
            try:
                urllib.request.urlopen(strict_base + SYNC_PATH + "/state", timeout=5)
            except urllib.error.HTTPError as error:
                strict_status = error.code
                error.read()
            check("未配置凭据时同源请求不再放行", strict_status == 401, str(strict_status))

            strict_status = 0
            try:
                urllib.request.urlopen(strict_base + SYNC_PATH + "/health", timeout=5)
            except urllib.error.HTTPError as error:
                strict_status = error.code
                error.read()
            check("health 仍然无需凭据", strict_status == 0, str(strict_status))
        finally:
            strict_httpd.shutdown()
            strict_httpd.server_close()

        httpd.shutdown()
        httpd.server_close()

        log("INFO", "Selftest", "section=reload-journal")
        reloaded = Journal(users.user_dir(DEFAULT_ACCOUNT_ID))
        check("最新序号一致", reloaded.latest_seq == 4, str(reloaded.latest_seq))
        check("日志身份保持不变", reloaded.journal_id == journal.journal_id, f"{reloaded.journal_id} != {journal.journal_id}")
        check("存活文件一致", sorted(reloaded.files.keys()) == ["notes/bound.md", "notes/one.md"], repr(reloaded.files))
        check("删除记录一致", reloaded.deleted.get("notes/two.md") == 3, repr(reloaded.deleted))
        check("重启后仍能续写", reloaded.append_many("dev-a", [{"opId": "a-4", "op": "put", "path": "notes/three.md", "data": "3"}])[0]["seq"] == 5)

        log("INFO", "Selftest", "section=recycle-ids")
        pool = Journal(os.path.join(tmp, "recycle-data"))
        pool.append_many("dev-a", [
            {"opId": "c-1", "op": "put", "path": "notes/123.md", "data": "一篇文章"},
            {"opId": "c-2", "op": "del", "path": "notes/123.md"},
        ])
        check("删除：留下删除记录、拿掉存活索引",
              pool.deleted.get("notes/123.md") == 2 and "notes/123.md" not in pool.files, repr(pool.state()))
        check("被删掉的 ID 进入回收池", [item["id"] for item in pool.recyclable()] == ["123"], repr(pool.recyclable()))

        first, pending = pool.claim_recyclable("dev-b", "notes", 1)
        second, _pending = pool.claim_recyclable("dev-c", "notes", 1)
        check("领走之后不再重复发放",
              [item["id"] for item in first] == ["123"] and second == [], f"{first}/{second}")

        pool.append_many("dev-a", [
            {"opId": "c-2b", "op": "put", "path": "notes/123.md", "data": "又建了一篇"},
            {"opId": "c-2c", "op": "del", "path": "notes/123.md"},
        ])
        behind, behind_pending = pool.claim_recyclable("dev-d", "notes", 1, 3)
        check("序号没跟上的设备先不发（发行时再拉一次日志就有了）",
              behind == [] and behind_pending == 1, f"{behind}/{behind_pending}")
        caught_up, _pending = pool.claim_recyclable("dev-d", "notes", 1, 5)
        check("序号跟上了就能领到", [item["id"] for item in caught_up] == ["123"], repr(caught_up))

        pool.append_many("dev-b", [{"opId": "c-3", "op": "put", "path": "notes/123.md", "data": "用同一个 ID 新建的一篇"}])
        check("用回收的 ID 新建后：删除记录撤销、ID 不再可复用",
              "notes/123.md" not in pool.deleted and "notes/123.md" in pool.files
              and pool.recyclable() == [] and pool.state()["recyclable"] == 0, repr(pool.state()))

        # 再删一次，这次由 dev-a 删：它自己不必等序号跟上就能把 ID 领回去，别的设备仍旧要等
        pool.append_many("dev-a", [{"opId": "c-3b", "op": "del", "path": "notes/123.md"}])
        own, _own_pending = pool.claim_recyclable("dev-a", "notes", 1, 0)
        check("发起删除的设备不必等自己的序号跟上就能领回这个 ID",
              [item["id"] for item in own] == ["123"], repr(own))
        others, others_pending = pool.claim_recyclable("dev-z", "notes", 1, 0)
        check("其他设备还是要等序号跟上", others == [] and others_pending == 1, f"{others}/{others_pending}")

        pool.append_many("dev-a", [
            {"opId": "c-4", "op": "put", "path": "notes/123.md", "data": "再建一次"},
            {"opId": "c-5", "op": "put", "path": "config.json", "data": "{}"},
            {"opId": "c-6", "op": "del", "path": "config.json"},
        ])
        check("回收池只认 notes/ 与 todos/ 下的条目",
              pool.recyclable() == [] and pool.deleted.get("config.json") == 9, repr(pool.state()))
        check("整理日志：非条目的路径也一样处理（只留删除标记）",
              pool.compact()["removed"] == 1 and pool.deleted.get("config.json") == 9
              and pool.latest_seq == 9, repr(pool.state()))

        log("INFO", "Selftest", "section=compact-journal")
        trim = Journal(os.path.join(tmp, "compact-data"))
        trim.append_many("dev-a", [
            {"opId": "t-1", "op": "put", "path": "notes/keep.md", "data": "活着的一篇"},
            {"opId": "t-2", "op": "put", "path": "notes/keep.md", "data": "活着的一篇（改过一版）"},
            {"opId": "t-3", "op": "put", "path": "notes/gone.md", "data": "要被彻底删掉的正文"},
            {"opId": "t-4", "op": "del", "path": "notes/gone.md"},
        ])
        compacted = trim.compact()
        with open(trim.path, "r", encoding="utf-8") as handle:
            trimmed_text = handle.read()
        check("整理日志：已彻底删除的那一条只剩删除标记，正文不再留在日志里",
              compacted["removed"] == 1 and "要被彻底删掉的正文" not in trimmed_text
              and "notes/gone.md" in trimmed_text, repr(compacted))
        check("整理日志：还活着的条目历史一行不动", trimmed_text.count("notes/keep.md") == 2, trimmed_text[:200])
        check("整理之后状态不变：序号、存活文件、删除记录、回收池",
              trim.latest_seq == 4 and sorted(trim.files.keys()) == ["notes/keep.md"]
              and trim.deleted.get("notes/gone.md") == 4
              and [item["id"] for item in trim.recyclable()] == ["gone"], repr(trim.state()))
        check("序号留了空洞也照样能按 since 增量拉",
              [item["seq"] for item in trim.read_ops(0, 10)] == [1, 2, 4]
              and [item["seq"] for item in trim.read_ops(2, 10)] == [4], repr(trim.read_ops(0, 10)))
        check("只整理指定路径：还有后续的路径不会被动",
              trim.compact(["notes/keep.md"])["removed"] == 0, repr(trim.state()))
        check("整理过的日志重启后重建一致",
              Journal(os.path.join(tmp, "compact-data")).deleted.get("notes/gone.md") == 4, repr(trim.state()))
        check("整理之后还能照常往下写",
              trim.append_many("dev-a", [{"opId": "t-5", "op": "put", "path": "notes/later.md", "data": "后来的"}])[0]["seq"] == 5,
              repr(trim.state()))

        # 又用同一个 ID 建了一篇、再彻底删掉：删除标记合并，以前记下的操作号不会丢
        trim.append_many("dev-a", [
            {"opId": "t-6", "op": "put", "path": "notes/gone.md", "data": "又建了一篇"},
            {"opId": "t-7", "op": "del", "path": "notes/gone.md"},
        ])
        trim.compact()
        with open(trim.path, "r", encoding="utf-8") as handle:
            again = handle.read()
        check("再删一次：新写的正文同样被抹掉",
              "又建了一篇" not in again and "要被彻底删掉的正文" not in again, again[:240])
        check("整理后的删除标记仍然认得重试的操作号",
              trim.latest_seq == 6 and trim.op_ids.get("t-3") == 6 and trim.op_ids.get("t-6") == 6,
              repr(trim.op_ids))

        blank = Journal(os.path.join(tmp, "blank-data"))
        blank_summary = blank.summary()
        check("空日志的概览：还没有任何操作",
              blank_summary["ops"] == 0 and blank_summary["size"] == 0 and blank_summary["exists"] is False,
              repr(blank_summary))
        check("空日志里没有可复用的 ID",
              blank.recyclable() == [] and blank_summary["recyclable"] == 0, repr(blank_summary))

        log("INFO", "Selftest", "section=reload-admin")
        reloaded_admin = UserStore(data_dir)
        check("管理密码重新加载后仍然有效",
              reloaded_admin.authenticate(DEFAULT_ACCOUNT_NAME, "new-pass-12")[0] is not None, "密码校验失败")
        check("账户只有内置的一个",
              [item["id"] for item in reloaded_admin.list_users()] == [DEFAULT_ACCOUNT_ID],
              repr(reloaded_admin.users))
        check("令牌保持删除后的状态", reloaded_admin.token_count() == 0, repr(reloaded_admin.tokens))
        check("会话只存在内存里", reloaded_admin.sessions == {}, repr(reloaded_admin.sessions))

        log("INFO", "Selftest", "section=legacy-migration")
        legacy_dir = os.path.join(tmp, "legacy-data")
        os.makedirs(legacy_dir, exist_ok=True)
        with open(os.path.join(legacy_dir, LEGACY_ADMIN_FILE_NAME), "w", encoding="utf-8") as handle:
            _json.dump({"version": 1, "password": hash_password("legacy-pass-1"), "secret": "a" * 64}, handle)
        with open(os.path.join(legacy_dir, JOURNAL_NAME), "w", encoding="utf-8") as handle:
            handle.write(_json.dumps({"seq": 1, "opId": "l-1", "op": "put",
                                      "path": "notes/old.md", "data": "旧数据"}, ensure_ascii=False) + "\n")
        with open(os.path.join(legacy_dir, JOURNAL_ID_NAME), "w", encoding="utf-8") as handle:
            handle.write("legacy-journal-id")
        with open(os.path.join(legacy_dir, TOKENS_FILE_NAME), "w", encoding="utf-8") as handle:
            _json.dump({"version": 1, "tokens": [{"id": "tk_old", "name": "旧令牌", "digest": "x", "enabled": True}]},
                       handle, ensure_ascii=False)

        migrated = UserStore(legacy_dir)
        admin_dir = migrated.user_dir(DEFAULT_ACCOUNT_ID)
        check("旧版 admin.json 的密码归到内置账户名下",
              migrated.password_set()
              and migrated.authenticate(DEFAULT_ACCOUNT_NAME, "legacy-pass-1")[0] is not None,
              repr(migrated.users))
        check("旧版日志搬进内置账户目录，根目录下不再留副本",
              os.path.isfile(os.path.join(admin_dir, JOURNAL_NAME))
              and not os.path.exists(os.path.join(legacy_dir, JOURNAL_NAME))
              and migrated.journal(DEFAULT_ACCOUNT_ID).latest_seq == 1,
              repr(migrated.journal(DEFAULT_ACCOUNT_ID).state())[:160])
        check("旧版日志身份跟着搬",
              migrated.journal(DEFAULT_ACCOUNT_ID).journal_id == "legacy-journal-id")
        check("旧版令牌归到内置账户名下",
              [item["name"] for item in migrated.list_tokens(DEFAULT_ACCOUNT_ID)] == ["旧令牌"]
              and not os.path.exists(os.path.join(legacy_dir, TOKENS_FILE_NAME)), repr(migrated.tokens))
        check("旧版 admin.json 已归档，不会再被读到",
              not os.path.exists(os.path.join(legacy_dir, LEGACY_ADMIN_FILE_NAME))
              and os.path.isfile(os.path.join(legacy_dir, LEGACY_ADMIN_FILE_NAME + ".migrated")),
              repr(sorted(os.listdir(legacy_dir))))
        again = UserStore(legacy_dir)
        check("再启动一次：账户、日志、令牌都还在",
              again.password_set() and again.journal(DEFAULT_ACCOUNT_ID).latest_seq == 1
              and len(again.list_tokens(DEFAULT_ACCOUNT_ID)) == 1, repr(again.users))

    if failures:
        log("ERROR", "Selftest", "failed={} cases={}".format(len(failures), ",".join(failures)))
        return 1
    log("INFO", "Selftest", "passed={} failed=0".format(passed))
    return 0


def config_path(data_dir):
    for candidate in (
        os.path.join(data_dir, CONFIG_NAME),
        os.path.join(SCRIPT_DIR, CONFIG_NAME),
        os.path.join(SCRIPT_DIR, "data", CONFIG_NAME),
    ):
        if os.path.isfile(candidate):
            return candidate
    return os.path.join(data_dir, CONFIG_NAME)


def read_config(data_dir):
    path = config_path(data_dir)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}

    config = {}

    try:
        port = int(data.get("port") or 0)
    except (TypeError, ValueError):
        port = 0
    if 1 <= port <= 65535:
        config["port"] = port

    host = str(data.get("host") or "").strip()
    if host:
        config["host"] = host

    return config


def lan_address():
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            return probe.getsockname()[0]
        finally:
            probe.close()
    except OSError:
        return ""


def main(argv=None):
    parser = argparse.ArgumentParser(description="EsprinSync 同步服务端（操作日志）")
    parser.add_argument("--host", help=f"监听地址，不传则用 {CONFIG_NAME} 里的 host，再不行用 {DEFAULT_HOST}（局域网共享可写 0.0.0.0）")
    parser.add_argument("--port", type=int, help=f"监听端口，不传则用 {CONFIG_NAME} 里的 port，再不行用 {DEFAULT_PORT}")
    parser.add_argument("--data", default="./data", help="数据目录：账户表与各账户的日志、令牌都在这里")
    parser.add_argument("--token", default=os.environ.get("ESPRIN_TOKEN", ""), help="访问令牌，等同内置账户的一份令牌；不传则凭据只来自管理后台（账户密码登录或在那里创建的访问令牌）")
    parser.add_argument("--selftest", action="store_true", help="跑一遍内置自测后退出")
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()

    data_dir = os.path.abspath(args.data)
    os.makedirs(data_dir, exist_ok=True)

    config_file = config_path(data_dir)
    config = read_config(data_dir)
    host = args.host or config.get("host") or DEFAULT_HOST
    port = args.port or config.get("port") or DEFAULT_PORT
    host_source = "--host" if args.host else ("config" if config.get("host") else "default")
    port_source = "--port" if args.port else ("config" if config.get("port") else "default")

    httpd, users = create_server(host, port, data_dir, args.token)
    journal = users.journal(DEFAULT_ACCOUNT_ID)

    bound_host, bound_port = httpd.server_address[:2]
    if bound_host in ("0.0.0.0", "::", ""):
        url_host = lan_address() or DEFAULT_HOST
    else:
        url_host = bound_host

    log("INFO", "Server", "启动 {} v{}".format(SERVER_NAME, SERVER_VERSION))
    log("INFO", "Server", "dataDir={} config={} configFound={}".format(data_dir, config_file, os.path.isfile(config_file)))
    log("INFO", "Server", "listen={}:{} hostSource={} portSource={}".format(bound_host, bound_port, host_source, port_source))
    log("INFO", "Sync", "endpoint={}/* origin=http://{}:{}".format(SYNC_PATH, url_host, bound_port))
    log("INFO", "Storage", "journal={} journalId={} ops={} latestSeq={}".format(
        journal.path, journal.journal_id, journal.count, journal.latest_seq))
    log("INFO", "Web", "endpoint=/ dir={} index={}".format(web_dir(), os.path.isfile(os.path.join(web_dir(), INDEX_NAME))))
    log("INFO", "Admin", "endpoint={} dir={} api={} passwordSet={}".format(
        ADMIN_PATH, manager_dir(), API_PREFIX, users.password_set()))
    log("INFO", "Auth", "tokenSource={} accountCount={} tokenCount={}".format(
        "--token" if args.token else "accounts", len(users.users), users.token_count()))
    if not users.password_set() and not users.token_count() and not args.token:
        log("WARN", "Auth", "未配置任何凭据：同步接口一律返回 401 (action=打开 {} 设置管理密码或创建访问令牌)".format(ADMIN_PATH))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("INFO", "Server", "已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

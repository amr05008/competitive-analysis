#!/usr/bin/env python3
"""Assemble each host's package from plugin/, and check what each one may contain.

plugin/ holds both hosts' files. ChatGPT's upload takes plugin.json and mcp.json; Claude's
takes .claude-plugin/, .mcp.json and README.md. Both take LICENSE, skills/ and assets/. The
committed MCP files carry only the production URL; a staging build swaps the URL in its
outputs, never in plugin/. Packages take only files git tracks, and nothing in plugin/ is
edited. Standard library only.

  python3 scripts/package.py [--server production|staging]
      production: dist/competitive-analysis-<v>.zip (OpenAI upload),
                  dist/competitive-analysis-<v>-claude.zip,
                  dist/chatgpt-local/ and dist/claude-local/
      staging:    the two folders and dist/competitive-analysis-<v>-claude-staging.zip

  python3 scripts/package.py --check <folder or .zip> [--server production|staging]

Every output is checked once written, and so is plugin/ itself, because Claude's directory
reads that folder from GitHub rather than from these zips. A failed check lists every
problem and exits 5.
"""
import argparse
import json
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugin"
DIST = ROOT / "dist"
LOCAL = ROOT / "local"  # Aaron's ChatGPT app mappings (local/chatgpt-app-<server>.json), git-ignored
EVALS = ROOT / "evals"  # claude plugin eval cases, copied into dist/claude-local only
EVAL_RESULTS = "evals/results"  # where claude plugin eval writes its reports; kept across builds

SERVER_KEY = "competitive-analysis"
SERVERS = {
    "production": "https://competitive-analysis.aaronmichaelroy.com/mcp",
    "staging": "https://competitive-analysis-staging.aaronmichaelroy.com/mcp",
}
SHARED = ["LICENSE", "skills", "assets"]
CHATGPT = ["plugin.json", "mcp.json", *SHARED]
CLAUDE = [".claude-plugin", ".mcp.json", "README.md", *SHARED]
JUNK = {".DS_Store", "Thumbs.db", "desktop.ini", "__MACOSX"}
APP_MAPPING = "./.app.json"
CHECK_FAILED = 5

# Claude's directory holds a version for a reviewer over these (pre-submission checklist).
MAX_FILE_BYTES = 256 * 1024
MAX_FILES = 512
EXEMPT_FROM_SIZE = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2", ".ttf", ".otf"}


class PackageError(Exception):
    pass


def is_junk(part):
    """A system file: Finder's and Windows' own, and macOS AppleDouble (._name) files."""
    return part in JUNK or part.startswith("._")


def git_files(*args):
    """Paths from a git ls-files call, read NUL-separated so no name is quoted."""
    out = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z", *args],
                         capture_output=True, check=True).stdout.decode()
    return [entry for entry in out.split("\0") if entry]


# ------------------------------------------------------------------ assembling

def collect(names, base=PLUGIN, prefix="", tracked=None):
    """{relative path: bytes} for the named files and folders, without system files.

    With `tracked`, every other file on disk is an error: a package takes committed files only.
    """
    files, stray = {}, []
    for name in names:
        if is_junk(name):
            continue
        path = base / name
        if path.is_symlink():
            raise PackageError(f"{path.relative_to(ROOT)} is a symlink; packages carry regular files only")
        if path.is_file():
            found = [path]
        elif path.is_dir():
            found = []
            for sub in sorted(path.rglob("*")):
                if any(is_junk(part) for part in sub.relative_to(base).parts):
                    continue
                if sub.is_symlink():
                    raise PackageError(f"{sub.relative_to(ROOT)} is a symlink; packages carry regular files only")
                if sub.is_file():
                    found.append(sub)
        else:
            raise PackageError(f"{path.relative_to(ROOT)} is missing")
        for f in found:
            rel = f.relative_to(base).as_posix()
            if tracked is not None and rel not in tracked:
                stray.append(f.relative_to(ROOT).as_posix())
            else:
                files[prefix + rel] = f.read_bytes()
    if stray:
        raise PackageError("\n  - ".join([f"{len(stray)} file(s) in plugin/ aren't committed, so no package takes them; "
                                          "git add or delete each:"] + [f"{s} isn't committed" for s in stray]))
    return files


def plugin_files(names):
    return collect(names, tracked={p.removeprefix("plugin/") for p in git_files("--", "plugin")})


def with_url(raw, url):
    """An MCP file with its one server pointed at url. Unchanged bytes when it already is."""
    data = json.loads(raw)
    server = data["mcpServers"][SERVER_KEY]
    if server.get("url") == url:
        return raw
    server["url"] = url
    return (json.dumps(data, indent=2) + "\n").encode()


def chatgpt_files(server, local):
    files = plugin_files(CHATGPT)
    files["mcp.json"] = with_url(files["mcp.json"], SERVERS[server])
    mapping = LOCAL / f"chatgpt-app-{server}.json"
    if local and mapping.is_file():
        # The app mapping is tied to Aaron's account, so it lives in local/ and only in this test folder.
        files[".app.json"] = mapping.read_bytes()
        manifest = json.loads(files["plugin.json"])
        manifest["extensions"]["com.openai"]["apps"] = APP_MAPPING
        files["plugin.json"] = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode()
    return files


def claude_files(server, local):
    files = plugin_files(CLAUDE)
    files[".mcp.json"] = with_url(files[".mcp.json"], SERVERS[server])
    if local and EVALS.is_dir():
        names = [p.name for p in sorted(EVALS.iterdir()) if p.name != EVAL_RESULTS.split("/")[1]]
        files.update(collect(names, EVALS, "evals/"))
    return files


def write_dir(files, path, keep=()):
    """Replace the folder with these files, keeping the `keep` subfolders as they were."""
    with tempfile.TemporaryDirectory(dir=path.parent) as hold:
        kept = [(path / k, Path(hold) / str(n)) for n, k in enumerate(keep) if (path / k).is_dir()]
        for src, held in kept:
            shutil.move(src, held)
        if path.exists():
            shutil.rmtree(path)
        for rel, data in files.items():
            out = path / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
        for src, held in kept:
            src.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(held, src)


def write_zip(files, path):
    """A zip with folder entries, fixed dates and plain permissions, so one commit gives one zip."""
    path.unlink(missing_ok=True)
    folders = sorted({"/".join(rel.split("/")[:i]) + "/" for rel in files for i in range(1, rel.count("/") + 1)})
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for folder in folders:
            info = zipfile.ZipInfo(folder, date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = (stat.S_IFDIR | 0o755) << 16 | 0x10
            z.writestr(info, b"")
        for rel in sorted(files):
            info = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, files[rel])


# --------------------------------------------------------------------- checking

def load(path):
    """(files, symlinks, folders, is_zip) for a folder or a zip."""
    files, links, folders = {}, [], []
    if path.is_file() and zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                if info.is_dir():
                    folders.append(info.filename.rstrip("/"))
                elif stat.S_ISLNK(info.external_attr >> 16):
                    links.append(info.filename)
                else:
                    files[info.filename] = z.read(info)
        return files, links, folders, True
    if not path.is_dir():
        raise PackageError(f"{path} is neither a folder nor a zip")
    for sub in sorted(path.rglob("*")):
        rel = sub.relative_to(path).as_posix()
        if sub.is_symlink():
            links.append(rel)
        elif sub.is_dir():
            folders.append(rel)
        elif sub.is_file():
            files[rel] = sub.read_bytes()
    return files, links, folders, False


def parse(files, name, problems):
    try:
        return json.loads(files[name])
    except (ValueError, UnicodeDecodeError) as e:
        problems.append(f"{name} isn't valid JSON ({e})")
        return None


def openai_apps(manifest):
    """(declared, value) for extensions.com.openai.apps, by key presence, whatever the value."""
    ext = manifest.get("extensions")
    openai = ext.get("com.openai") if isinstance(ext, dict) else None
    if isinstance(openai, dict) and "apps" in openai:
        return True, openai["apps"]
    return False, None


def manifest_problems(name, manifest):
    """What no manifest may carry: its own server list (the one server is in the MCP file) or a top-level apps."""
    problems = []
    if not isinstance(manifest, dict):
        return [f"{name} isn't a JSON object"]
    if "mcpServers" in manifest:
        problems.append(f"{name} declares mcpServers; the one server is declared only in the MCP file")
    if "apps" in manifest:
        problems.append(f"{name} has a top-level apps key; the app mapping goes only in extensions.com.openai.apps of a local test build")
    return problems


def check_mcp(files, name, kind, server, problems):
    """One server, under its key, at an https URL that matches the build."""
    data = parse(files, name, problems)
    if not isinstance(data, dict):
        return
    allowed = {"$schema", "mcpServers"} if kind == "chatgpt" else {"mcpServers"}
    extra = sorted(set(data) - allowed)
    if extra:
        problems.append(f"{name} has keys {extra}; only {sorted(allowed)} are allowed")
    servers = data.get("mcpServers")
    if not isinstance(servers, dict) or len(servers) != 1:
        problems.append(f"{name} must declare exactly one server, not {0 if not isinstance(servers, dict) else len(servers)}")
        return
    key, entry = next(iter(servers.items()))
    if key != SERVER_KEY:
        problems.append(f"{name}'s server is named {key!r}; it must be {SERVER_KEY!r}")
    if not isinstance(entry, dict):
        problems.append(f"{name}'s server entry isn't an object")
        return
    want_type = "streamable-http" if kind == "chatgpt" else "http"
    if entry.get("type") != want_type:
        problems.append(f"{name}'s server type is {entry.get('type')!r}; it must be {want_type!r}")
    if set(entry) != {"type", "url"}:
        problems.append(f"{name}'s server has keys {sorted(entry)}; only type and url are allowed")
    url = entry.get("url")
    if not isinstance(url, str) or not url.startswith("https://"):
        problems.append(f"{name}'s server URL {url!r} isn't https")
    elif server and url != SERVERS[server]:
        problems.append(f"{name} points at {url}, but this is a {server} build ({SERVERS[server]})")
    elif not server and url not in SERVERS.values():
        problems.append(f"{name} points at {url}, which is neither the production nor the staging server")


def check(files, links, folders, is_zip, server=None):
    """Every problem with one output. ChatGPT or Claude is read from which manifest it carries."""
    problems = [f"{rel} is a symlink" for rel in links]
    names = set(files)
    tops = {rel.split("/")[0] for rel in [*names, *links, *folders]}
    chatgpt, claude = "plugin.json" in names, ".claude-plugin/plugin.json" in names
    if chatgpt and claude:
        return problems + ["carries both plugin.json and .claude-plugin/plugin.json; a package is for one host"]
    if not (chatgpt or claude):
        return problems + ["has neither plugin.json (ChatGPT) nor .claude-plugin/plugin.json (Claude)"]
    kind = "chatgpt" if chatgpt else "claude"

    for rel in sorted(names):
        if any(is_junk(part) for part in rel.split("/")):
            problems.append(f"{rel} is a system file")

    # Only this host's own top-level names; the other host's files get a message of their own.
    own_mcp, other_mcp = ("mcp.json", ".mcp.json") if kind == "chatgpt" else (".mcp.json", "mcp.json")
    if kind == "chatgpt":
        allowed = set(CHATGPT) | (set() if is_zip else {".app.json"})
        others = {".claude-plugin": "Claude's; the ChatGPT package leaves it out",
                  "README.md": "Claude's; the ChatGPT package leaves it out"}
    else:
        allowed = set(CLAUDE) | (set() if is_zip else {"evals"})
        others = {"plugin.json": "ChatGPT's; the Claude package leaves it out",
                  ".app.json": "ChatGPT's; the Claude package leaves it out"}
    handled_below = {".app.json"} if kind == "chatgpt" else set()
    for top in sorted(tops - allowed - handled_below):
        if top == other_mcp:
            problems.append(f"{other_mcp} is the other host's MCP file")
        elif top in others:
            problems.append(f"{top} is {others[top]}")
        elif top == "evals":
            problems.append("evals/ belongs only in dist/claude-local")
        elif not is_junk(top):
            problems.append(f"{top} doesn't belong in a package")

    required = ["LICENSE", "skills/teardown/SKILL.md", own_mcp] + (["README.md"] if kind == "claude" else [])
    problems += [f"{rel} is missing" for rel in required if rel not in names]
    if own_mcp in names:
        check_mcp(files, own_mcp, kind, server, problems)

    manifest_name = "plugin.json" if kind == "chatgpt" else ".claude-plugin/plugin.json"
    manifest = parse(files, manifest_name, problems)
    if manifest is not None:
        problems += manifest_problems(manifest_name, manifest)
    if kind == "chatgpt" and isinstance(manifest, dict):
        declared, apps = openai_apps(manifest)
        if is_zip:
            # OpenAI refuses an upload with either (app_configuration_excluded).
            if declared:
                problems.append("plugin.json has extensions.com.openai.apps; OpenAI refuses it in an upload")
            if ".app.json" in names:
                problems.append(".app.json is in an upload; OpenAI refuses it")
        elif ".app.json" in names:
            if apps != APP_MAPPING:
                problems.append(f".app.json is here, but plugin.json doesn't map it (extensions.com.openai.apps: {APP_MAPPING!r})")
            app = parse(files, ".app.json", problems)
            if app is not None and (not isinstance(app, dict) or not app):
                problems.append(".app.json is empty; it must be the mapping the app's plugin creator wrote")
        elif declared:
            problems.append(f"plugin.json maps apps to {apps!r}, but there's no .app.json")
    return problems


def check_listed_folder():
    """plugin/ as Claude's directory reads it: the committed files, within the directory's limits."""
    problems, count = [], 0
    for entry in git_files("-s", "--", "plugin"):
        meta, rel = entry.split("\t", 1)
        mode = meta.split()[0]
        count += 1
        if mode in ("120000", "160000"):
            problems.append(f"{rel} is a symlink or submodule")
        elif any(is_junk(part) for part in rel.split("/")):
            problems.append(f"{rel} is a system file")
        else:
            path = ROOT / rel
            if path.suffix.lower() not in EXEMPT_FROM_SIZE and path.is_file() and path.stat().st_size > MAX_FILE_BYTES:
                problems.append(f"{rel} is {path.stat().st_size // 1024} KiB; over 256 KiB holds every version for a reviewer")
    if count > MAX_FILES:
        problems.append(f"plugin/ has {count} files; over {MAX_FILES} holds every version for a reviewer")
    # The directory reads these from GitHub as they are, so only the production URL is ever committed,
    # and no manifest declares a server of its own or the app mapping.
    for name, kind in (("mcp.json", "chatgpt"), (".mcp.json", "claude")):
        found = []
        check_mcp({name: (PLUGIN / name).read_bytes()}, name, kind, "production", found)
        problems += [f"plugin/{p}" for p in found]
    for name in ("plugin.json", ".claude-plugin/plugin.json"):
        found = []
        manifest = parse({name: (PLUGIN / name).read_bytes()}, name, found)
        if manifest is not None:
            found += manifest_problems(name, manifest)
            if openai_apps(manifest)[0]:
                found.append(f"{name} has extensions.com.openai.apps; the app mapping is never committed")
        problems += [f"plugin/{p}" for p in found]
    return problems


# ------------------------------------------------------------------------- main

def report(label, problems):
    if problems:
        print(f"package: {label} failed its check:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
    return not problems


def build(server):
    version = json.loads((PLUGIN / "plugin.json").read_text(encoding="utf-8"))["version"]
    ok = report("plugin/", check_listed_folder())
    outputs = [
        (DIST / "chatgpt-local", chatgpt_files(server, local=True), write_dir),
        (DIST / "claude-local", claude_files(server, local=True),
         lambda files, path: write_dir(files, path, keep=(EVAL_RESULTS,))),
    ]
    if server == "production":
        outputs += [
            (DIST / f"competitive-analysis-{version}.zip", chatgpt_files(server, local=False), write_zip),
            (DIST / f"competitive-analysis-{version}-claude.zip", claude_files(server, local=False), write_zip),
        ]
    else:
        outputs.append((DIST / f"competitive-analysis-{version}-claude-staging.zip", claude_files(server, local=False), write_zip))
    DIST.mkdir(exist_ok=True)
    for path, files, write in outputs:
        write(files, path)
        if report(path.relative_to(ROOT).as_posix(), check(*load(path), server)):
            print(f"package: wrote {path.relative_to(ROOT)} ({server}, checked)")
        else:
            ok = False
            if path.suffix == ".zip":
                path.unlink()  # never leave a zip that failed its check where it could be uploaded
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--server", choices=sorted(SERVERS), help="the build's server; with --check, the URL it must carry")
    ap.add_argument("--check", metavar="PATH", type=Path, help="check a package folder or zip instead of building")
    args = ap.parse_args()
    try:
        if args.check:
            ok = report(str(args.check), check(*load(args.check), args.server))
            if ok:
                print(f"package: {args.check} passed")
        else:
            ok = build(args.server or "production")
    except PackageError as e:
        print(f"package: {e}", file=sys.stderr)
        sys.exit(CHECK_FAILED)
    sys.exit(0 if ok else CHECK_FAILED)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Copy the store listing into plugin.json and check it against the directory's rules.

Claude's manifest, .claude-plugin/plugin.json, gets the same version and display name; the
rest of it is edited by hand.

listing/competitive-analysis-listing.md is the one place the listing is edited (in Obsidian,
through a vault symlink). Its frontmatter holds the short fields, the body's "## Description"
is the long description, and the newest "### <version>" under "## Release notes" goes out as
that version's release notes. Every problem is reported at once; nothing is written unless
all checks pass. Standard library only.
"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugin"  # the folder Claude's directory lists (Decision 1, 2026-10-26)
LISTING = Path(os.environ.get("LISTING", ROOT / "listing" / "competitive-analysis-listing.md"))
MANIFEST = PLUGIN / "plugin.json"
CLAUDE_MANIFEST = PLUGIN / ".claude-plugin" / "plugin.json"  # gets version and displayName only
PLUGIN_ID = "competitive-analysis"  # fixed for the life of the listing
# Vendor names belong in the listing and on the site, never in a model-readable file.
VENDORS = ["Clay", "Exa", "Firecrawl", "Monid"]
FIELDS = ["version", "name", "subtitle", "category", "prompts"]
# developers.openai.com/plugins/deploy/submission-errors, checked 2026-10-18
CATEGORIES = ["Productivity", "Creativity", "Developer Tools", "Business & Operations",
              "Data & Analytics", "Communication", "Education & Research", "Security",
              "Finance", "Healthcare", "Travel", "Entertainment", "Other"]
OBSIDIAN_FIELDS = {"tags", "aliases", "cssclasses"}  # Obsidian may add these; ignored


def unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] == "'":
        return v[1:-1].replace("''", "'")
    if len(v) >= 2 and v[0] == v[-1] == '"':
        return v[1:-1].replace('\\"', '"')
    return v


def frontmatter(block, errors):
    """The YAML subset Obsidian's Properties writes: scalars and one-per-line lists."""
    meta, key = {}, None
    for line in block.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        item = re.match(r"\s*-\s+(.*)$", line)
        if item:
            if key is not None and isinstance(meta.get(key), list):
                meta[key].append(unquote(item.group(1)))
            elif key not in OBSIDIAN_FIELDS:
                errors.append(f"frontmatter: list item outside a list: {line.strip()!r}")
            continue
        kv = re.match(r"([A-Za-z_][\w-]*):\s*(.*)$", line)
        if not kv:
            errors.append(f"frontmatter: can't read {line.strip()!r}")
            continue
        key, val = kv.group(1), kv.group(2).strip()
        if key in OBSIDIAN_FIELDS:
            continue
        if val in ("", "[]"):
            meta[key] = []
        elif val.startswith("["):
            errors.append(f"frontmatter: write {key} one per line, not as [a, b]")
        else:
            meta[key] = unquote(val)
    return meta


def sections(text, level):
    """Text under each heading of exactly `level` #s, in order."""
    out, cur = {}, None
    for line in text.splitlines():
        h = re.match(r"(#{1,6})\s+(.*?)\s*$", line)
        if h and len(h.group(1)) <= level:
            cur = h.group(2) if len(h.group(1)) == level else None
            if cur is not None:
                out[cur] = []
            continue
        if cur is not None:
            out[cur].append(line)
    return {k: "\n".join(v) for k, v in out.items()}


def plain(text):
    """Drop Obsidian and HTML comments, trailing spaces, and extra blank lines."""
    text = re.sub(r"%%.*?%%|<!--.*?-->", "", text, flags=re.S)
    text = "\n".join(line.rstrip() for line in text.splitlines())
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def check_length(errors, label, value, limit):
    if not value:
        errors.append(f"{label} is empty")
    elif len(value) > limit:
        errors.append(f"{label} is {len(value)} characters; the limit is {limit}: {value!r}")


def vendor_mentions():
    found = []
    pattern = re.compile(r"\b(" + "|".join(VENDORS) + r")\b")
    for path in sorted((PLUGIN / "skills").rglob("*.md")):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for m in pattern.finditer(line):
                found.append(f"{path.relative_to(ROOT)}:{n} names {m.group(1)}")
    return found


def main():
    errors = []
    text = LISTING.read_text(encoding="utf-8")
    m = re.match(r"---\n(.*?)\n---\n(.*)\Z", text, re.S)
    if not m:
        sys.exit(f"listing: {LISTING} has no frontmatter between --- lines")
    meta = frontmatter(m.group(1), errors)
    body = sections(m.group(2), 2)

    for field in FIELDS:
        if field not in meta:
            errors.append(f"frontmatter: {field} is missing")
    for field in meta:
        if field not in FIELDS:
            errors.append(f"frontmatter: unknown field {field!r} (known: {', '.join(FIELDS)})")

    version = meta.get("version", "")
    if isinstance(version, list) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        errors.append(f"version must look like 1.2.3, not {version!r}")
    for field, label in (("name", "name"), ("subtitle", "subtitle"), ("category", "category")):
        if isinstance(meta.get(field), list):
            errors.append(f"{label} must be one line of text")
    check_length(errors, "name", str(meta.get("name", "")), 30)
    check_length(errors, "subtitle", str(meta.get("subtitle", "")), 30)
    if meta.get("category") not in CATEGORIES:
        errors.append(f"category {meta.get('category')!r} isn't one the directory accepts: "
                      f"{', '.join(CATEGORIES)}")

    prompts = meta.get("prompts", [])
    if not isinstance(prompts, list) or not prompts:
        errors.append("prompts: list one to three, one per line")
        prompts = []
    elif len(prompts) > 3:
        errors.append(f"prompts: {len(prompts)} listed; the limit is 3")
    for i, p in enumerate(prompts, 1):
        check_length(errors, f"prompt {i}", p, 128)

    if "Description" not in body:
        errors.append("body: no '## Description' section")
    description = plain(body.get("Description", ""))
    check_length(errors, "description", description, 4000)

    notes = sections(body.get("Release notes", ""), 3)
    if not notes:
        errors.append("body: no '### <version>' under '## Release notes'")
        newest, release_notes = None, ""
    else:
        newest = next(iter(notes))
        release_notes = plain(notes[newest])
        if newest != version:
            errors.append(f"release notes: newest heading is {newest}, but version is {version}; "
                          f"add '### {version}' at the top of Release notes")
        if not release_notes:
            errors.append(f"release notes for {newest} are empty")

    errors += vendor_mentions()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    claude = json.loads(CLAUDE_MANIFEST.read_text(encoding="utf-8"))
    for path, m in ((MANIFEST, manifest), (CLAUDE_MANIFEST, claude)):
        if m.get("name") != PLUGIN_ID:
            errors.append(f"{path.relative_to(PLUGIN)} name is {m.get('name')!r}; the plugin id must stay {PLUGIN_ID!r}")

    if errors:
        print(f"listing: {LISTING.name} not copied into the manifests:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    openai = manifest["extensions"]["com.openai"]
    iface = openai["interface"]
    before = {MANIFEST: json.dumps(manifest, sort_keys=True), CLAUDE_MANIFEST: json.dumps(claude, sort_keys=True)}
    manifest["version"] = version
    iface["displayName"] = meta["name"]
    iface["shortDescription"] = meta["subtitle"]
    iface["longDescription"] = description
    iface["category"] = meta["category"]
    iface["defaultPrompt"] = prompts
    openai.setdefault("publication", {})["release_notes"] = release_notes
    claude["version"] = version
    claude["displayName"] = meta["name"]
    for path, m in ((MANIFEST, manifest), (CLAUDE_MANIFEST, claude)):
        rel = path.relative_to(PLUGIN)
        if json.dumps(m, sort_keys=True) == before[path]:
            print(f"listing: {rel} already matches {LISTING.name} ({version})")
        else:
            path.write_text(json.dumps(m, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"listing: wrote {rel} from {LISTING.name} ({version})")


if __name__ == "__main__":
    main()

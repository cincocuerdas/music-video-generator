from __future__ import annotations

import csv
import re
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
AUDIT_MD = ROOT / "output" / "audit" / "AUDIT_RUNS.md"
RUNS_CSV = ROOT / "docs" / "quality-tracking-template.csv"
SCENES_CSV = ROOT / "docs" / "scene-quality-tracking-template.csv"

RUN_FIELDNAMES = [
    "run_id",
    "project_id",
    "date",
    "song_title",
    "style",
    "source_mode",
    "total_scenes",
    "real_scenes",
    "fallback_scenes",
    "degraded_scenes",
    "overall_status",
    "total_likes",
    "total_dislikes",
    "degraded_rate",
    "fallback_rate",
    "primary_provider",
    "secondary_provider",
    "top_failure_1",
    "top_failure_2",
    "top_failure_3",
    "decision",
    "notes",
]

SCENE_FIELDNAMES = [
    "run_id",
    "scene_index",
    "timestamp_range",
    "verse_type",
    "verse_text",
    "provider",
    "model",
    "quality_score",
    "exposed",
    "user_feedback",
    "failure_tags",
    "passed_visual_review",
    "reason",
    "notes",
]


RUN_HEADING_RE = re.compile(
    r"^##\s+P(?P<run>\d+)\s+[—-]\s+(?P<title>.+?)\s+\((?P<style>.+?),\s+(?P<scenes>\d+)\s+scenes?\)"
)
PROJECT_RE = re.compile(r"\*\*Project:\*\*\s+`(?P<project_id>[^`]+)`")
PROVIDER_RE = re.compile(
    r"\*\*Provider:\*\*\s+(?P<provider>[^\s(]+).*?\*\*Model:\*\*\s+(?P<model>[^\n`]+)"
)
INDEX_ROW_RE = re.compile(
    r"^\|\s*P(?P<run>\d+)\s*\|\s*(?P<style>[^|]+)\|\s*(?P<scenes>\d+)\s*\|\s*(?P<date>\d{4}-\d{2}-\d{2})\s*\|\s*(?P<decision>[^|]+)\|"
)


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, str]], fieldnames: list[str]) -> None:
    backup_path = path.with_suffix(path.suffix + ".bak")
    shutil.copyfile(path, backup_path)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def normalize_run_id(run_token: str) -> str:
    return f"run_{int(run_token):03d}"


def normalize_decision(raw: str, existing: str = "") -> str:
    candidate = existing or raw
    normalized = candidate.strip().strip(",").lower()
    mapping = {
        "pending visual review": "pending_review",
        "pending_review": "pending_review",
        "usable as-is": "usable_as_is",
        "usable_as_is": "usable_as_is",
        "usable with minor edits": "usable_minor_edits",
        "usable_minor_edits": "usable_minor_edits",
        "not publishable": "not_publishable",
        "not_publishable": "not_publishable",
        "superseded by p4": "pending_review",
    }
    return mapping.get(normalized, "pending_review")


def clean_cell(value: str) -> str:
    return (value or "").strip().strip(",")


def split_pipe_row(line: str) -> list[str]:
    parts = [part.strip() for part in line.strip().strip("|").split("|")]
    return parts


def parse_index_map(content: str) -> dict[str, dict[str, str]]:
    index: dict[str, dict[str, str]] = {}
    for line in content.splitlines():
        match = INDEX_ROW_RE.match(line)
        if not match:
            continue
        run_id = normalize_run_id(match.group("run"))
        index[run_id] = {
            "date": match.group("date").strip(),
            "decision": match.group("decision").strip(),
        }
    return index


def parse_runs_md(content: str) -> tuple[dict[str, dict[str, str]], dict[tuple[str, str], dict[str, str]]]:
    index_map = parse_index_map(content)
    run_rows: dict[str, dict[str, str]] = {}
    scene_rows: dict[tuple[str, str], dict[str, str]] = {}

    current_run_id = ""
    current_run: dict[str, str] | None = None
    in_scene_table = False

    for raw_line in content.splitlines():
        line = raw_line.rstrip()
        heading = RUN_HEADING_RE.match(line)
        if heading:
            run_id = normalize_run_id(heading.group("run"))
            current_run_id = run_id
            current_run = {
                "run_id": run_id,
                "project_id": "",
                "date": index_map.get(run_id, {}).get("date", ""),
                "song_title": heading.group("title").strip(),
                "style": heading.group("style").strip(),
                "source_mode": "audit",
                "total_scenes": heading.group("scenes").strip(),
                "real_scenes": heading.group("scenes").strip(),
                "fallback_scenes": "0",
                "degraded_scenes": "0",
                "overall_status": "success",
                "total_likes": "0",
                "total_dislikes": "0",
                "degraded_rate": "0.00",
                "fallback_rate": "0.00",
                "primary_provider": "",
                "secondary_provider": "",
                "top_failure_1": "",
                "top_failure_2": "",
                "top_failure_3": "",
                "decision": normalize_decision(index_map.get(run_id, {}).get("decision", "")),
                "notes": "",
            }
            run_rows[run_id] = current_run
            in_scene_table = False
            continue

        if not current_run:
            continue

        project_match = PROJECT_RE.search(line)
        if project_match:
            current_run["project_id"] = clean_cell(project_match.group("project_id"))
            continue

        provider_match = PROVIDER_RE.search(line)
        if provider_match:
            current_run["primary_provider"] = clean_cell(provider_match.group("provider"))
            continue

        if line.startswith("| Sc | Subject | verseType | Q | Provider | Failure Tags | Evidence |") or line.startswith("| sc | Q | archetype | prompt summary | was (pre-fix) |"):
            in_scene_table = True
            continue
        if in_scene_table and re.match(r"^\|\s*-", line):
            continue

        if in_scene_table and line.startswith("|"):
            cols = split_pipe_row(line)
            if cols and cols[0].lower() in {"sc", "run", "metric"}:
                continue
            if len(cols) == 7:
                scene_index, subject, verse_type, quality, provider, failure_tags, evidence = cols
                scene_rows[(current_run_id, scene_index)] = {
                    "run_id": current_run_id,
                    "scene_index": clean_cell(scene_index),
                    "timestamp_range": "",
                    "verse_type": clean_cell(verse_type),
                    "verse_text": clean_cell(subject),
                    "provider": clean_cell(provider),
                    "model": "gemini-3-pro-image-preview" if provider == "gemini" else "",
                    "quality_score": quality.replace("**", ""),
                    "exposed": "true",
                    "user_feedback": "",
                    "failure_tags": "" if failure_tags in {"—", "-", ""} else failure_tags.replace("`", ""),
                    "passed_visual_review": "",
                    "reason": "",
                    "notes": "" if evidence in {"—", "-", ""} else evidence,
                }
                continue
            if len(cols) == 5 and current_run_id == "run_011":
                scene_index, quality, archetype, prompt_summary, was = cols
                scene_rows[(current_run_id, scene_index)] = {
                    "run_id": current_run_id,
                    "scene_index": clean_cell(scene_index),
                    "timestamp_range": "",
                    "verse_type": "",
                    "verse_text": clean_cell(prompt_summary),
                    "provider": "gemini",
                    "model": "gemini-3-pro-image-preview",
                    "quality_score": clean_cell(quality),
                    "exposed": "true",
                    "user_feedback": "",
                    "failure_tags": "",
                    "passed_visual_review": "",
                    "reason": "",
                    "notes": f"archetype={archetype}; previous={was}",
                }
                continue

        if line.startswith("**Known issue:**") or line.startswith("**Known issues:**") or line.startswith("**Regression test:**") or line.startswith("**Result:"):
            note = re.sub(r"^\*\*[^*]+\*\*\s*", "", line).strip()
            current_run["notes"] = clean_cell(note)

    # Post-process degraded counts and top failures from scene rows.
    for run_id, run in run_rows.items():
        scenes = [row for (rid, _), row in scene_rows.items() if rid == run_id]
        if not run["primary_provider"]:
            providers = {row.get("provider", "") for row in scenes if row.get("provider")}
            if len(providers) == 1:
                run["primary_provider"] = sorted(providers)[0]
        degraded = sum(1 for row in scenes if float((row.get("quality_score") or "0").replace("**", "") or 0) < 0.82)
        run["degraded_scenes"] = str(degraded)
        run["overall_status"] = "degraded" if degraded else "success"
        total_scenes = int(run["total_scenes"] or "0")
        run["degraded_rate"] = f"{(degraded / total_scenes):.2f}" if total_scenes else "0.00"

        tags: list[str] = []
        for row in scenes:
            for tag in (row.get("failure_tags") or "").split(","):
                tag = tag.strip()
                if tag and tag not in tags:
                    tags.append(tag)
        for idx in range(3):
            run[f"top_failure_{idx + 1}"] = tags[idx] if idx < len(tags) else ""

    return run_rows, scene_rows


def merge_runs(existing_rows: list[dict[str, str]], parsed_rows: dict[str, dict[str, str]]) -> list[dict[str, str]]:
    merged: dict[str, dict[str, str]] = {row["run_id"]: row.copy() for row in existing_rows}
    for run_id, parsed in parsed_rows.items():
        existing = merged.get(run_id, {})
        row = {field: existing.get(field, "") for field in RUN_FIELDNAMES}
        for field in RUN_FIELDNAMES:
            parsed_value = parsed.get(field, "")
            if field == "decision":
                row[field] = normalize_decision(parsed_value, "")
                continue
            if field in {"top_failure_1", "top_failure_2", "top_failure_3"}:
                row[field] = clean_cell(parsed_value)
                continue
            if existing.get(field) and field in {"notes", "degraded_scenes", "overall_status", "degraded_rate"}:
                row[field] = clean_cell(existing[field])
                continue
            row[field] = clean_cell(parsed_value or existing.get(field, ""))
        merged[run_id] = row
    return [merged[run_id] for run_id in sorted(merged.keys())]


def merge_scenes(existing_rows: list[dict[str, str]], parsed_rows: dict[tuple[str, str], dict[str, str]]) -> list[dict[str, str]]:
    merged: dict[tuple[str, str], dict[str, str]] = {
        (row["run_id"], row["scene_index"]): row.copy() for row in existing_rows
    }
    for key, parsed in parsed_rows.items():
        existing = merged.get(key, {})
        row = {field: existing.get(field, "") for field in SCENE_FIELDNAMES}
        for field in SCENE_FIELDNAMES:
            if existing.get(field) and field in {"passed_visual_review", "reason", "user_feedback", "failure_tags", "notes"}:
                row[field] = clean_cell(existing[field])
                continue
            row[field] = clean_cell(parsed.get(field, "") or existing.get(field, ""))
        merged[key] = row

    def sort_key(item: tuple[tuple[str, str], dict[str, str]]) -> tuple[int, int]:
        (run_id, scene_index), _ = item
        return (int(run_id.split("_")[1]), int(scene_index))

    return [row for _, row in sorted(merged.items(), key=sort_key)]


def apply_run_decisions_from_scenes(
    runs: list[dict[str, str]], scenes: list[dict[str, str]]
) -> list[dict[str, str]]:
    scenes_by_run: dict[str, list[dict[str, str]]] = {}
    for scene in scenes:
        scenes_by_run.setdefault(scene["run_id"], []).append(scene)

    valid_decisions = {"usable_as_is", "usable_minor_edits", "not_publishable", "pending_review"}
    for run in runs:
        existing_decision = clean_cell(run.get("decision", ""))
        if existing_decision in valid_decisions and existing_decision != "pending_review":
            continue

        run_scenes = scenes_by_run.get(run["run_id"], [])
        reviewed = 0
        failed = 0
        for scene in run_scenes:
            state = clean_cell(scene.get("passed_visual_review", "")).lower()
            if state in {"yes", "true", "1"}:
                reviewed += 1
            elif state in {"no", "false", "0"}:
                reviewed += 1
                failed += 1

        if reviewed == 0:
            run["decision"] = "pending_review"
        elif failed == 0:
            run["decision"] = "usable_as_is"
        elif (failed / reviewed) >= 0.5:
            run["decision"] = "not_publishable"
        else:
            run["decision"] = "usable_minor_edits"

    return runs


def main() -> None:
    if not AUDIT_MD.exists():
        raise SystemExit(f"Missing audit ledger: {AUDIT_MD}")

    existing_runs = read_csv(RUNS_CSV)
    existing_scenes = read_csv(SCENES_CSV)
    content = AUDIT_MD.read_text(encoding="utf-8")
    parsed_runs, parsed_scenes = parse_runs_md(content)

    merged_scenes = merge_scenes(existing_scenes, parsed_scenes)
    merged_runs = merge_runs(existing_runs, parsed_runs)
    merged_runs = apply_run_decisions_from_scenes(merged_runs, merged_scenes)

    write_csv(RUNS_CSV, merged_runs, RUN_FIELDNAMES)
    write_csv(SCENES_CSV, merged_scenes, SCENE_FIELDNAMES)

    print("quality_tracking_sync")
    print(f"runs_written={len(merged_runs)}")
    print(f"scenes_written={len(merged_scenes)}")
    print(f"source={AUDIT_MD}")
    print(f"runs_csv={RUNS_CSV}")
    print(f"scenes_csv={SCENES_CSV}")


if __name__ == "__main__":
    main()

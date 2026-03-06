from __future__ import annotations

import csv
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[2]
RUNS_CSV = ROOT / "docs" / "quality-tracking-template.csv"
SCENES_CSV = ROOT / "docs" / "scene-quality-tracking-template.csv"


def parse_float(value: str) -> float:
    try:
        return float(value or 0)
    except ValueError:
        return 0.0


def parse_int(value: str) -> int:
    try:
        return int(value or 0)
    except ValueError:
        return 0


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def parse_bool(value: str) -> bool | None:
    normalized = (value or "").strip().lower()
    if normalized in {"yes", "true", "1"}:
        return True
    if normalized in {"no", "false", "0"}:
        return False
    return None


def split_tags(tags_raw: str) -> list[str]:
    return [tag.strip() for tag in (tags_raw or "").split(",") if tag.strip()]


def avg(values: Iterable[float]) -> float:
    values = list(values)
    if not values:
        return 0.0
    return sum(values) / len(values)


def print_ranked_runs(title: str, rows: list[tuple[str, float, int, int]]) -> None:
    print(title)
    if not rows:
        print("- none")
        return
    for run_id, failure_ratio, failed, reviewed in rows:
        print(
            f"- {run_id}: failed_visual_ratio={failure_ratio:.2%} "
            f"failed={failed} reviewed={reviewed}"
        )


def main() -> None:
    runs = read_csv(RUNS_CSV)
    scenes = read_csv(SCENES_CSV)

    total_runs = len(runs)
    total_scenes = sum(parse_int(row.get("total_scenes", "")) for row in runs)
    total_degraded_scenes = sum(parse_int(row.get("degraded_scenes", "")) for row in runs)
    total_fallback_scenes = sum(parse_int(row.get("fallback_scenes", "")) for row in runs)
    total_likes = sum(parse_int(row.get("total_likes", "")) for row in runs)
    total_dislikes = sum(parse_int(row.get("total_dislikes", "")) for row in runs)

    degraded_rate = (total_degraded_scenes / total_scenes) if total_scenes else 0.0
    fallback_rate = (total_fallback_scenes / total_scenes) if total_scenes else 0.0

    feedback_total = total_likes + total_dislikes
    like_rate = (total_likes / feedback_total) if feedback_total else None

    tag_counter: Counter[str] = Counter()
    failed_scene_count = 0
    passed_scene_count = 0
    run_ids_by_tag: defaultdict[str, set[str]] = defaultdict(set)
    scene_class_provider_hits: Counter[tuple[str, str, str, str]] = Counter()
    scenes_by_run: defaultdict[str, list[dict[str, str]]] = defaultdict(list)
    style_totals: defaultdict[str, dict[str, float]] = defaultdict(
        lambda: {"runs": 0, "scenes": 0, "degraded": 0, "fallback": 0}
    )
    provider_totals: defaultdict[str, dict[str, float]] = defaultdict(
        lambda: {"runs": 0, "scenes": 0, "degraded": 0, "fallback": 0}
    )
    model_totals: defaultdict[str, dict[str, float]] = defaultdict(
        lambda: {"reviewed": 0, "passed": 0, "failed": 0, "avg_quality": 0.0}
    )

    for row in runs:
        style = (row.get("style") or "unknown").strip() or "unknown"
        provider = (row.get("primary_provider") or "unknown").strip() or "unknown"
        total_scene_count = parse_int(row.get("total_scenes", ""))
        degraded_scene_count = parse_int(row.get("degraded_scenes", ""))
        fallback_scene_count = parse_int(row.get("fallback_scenes", ""))

        style_totals[style]["runs"] += 1
        style_totals[style]["scenes"] += total_scene_count
        style_totals[style]["degraded"] += degraded_scene_count
        style_totals[style]["fallback"] += fallback_scene_count

        provider_totals[provider]["runs"] += 1
        provider_totals[provider]["scenes"] += total_scene_count
        provider_totals[provider]["degraded"] += degraded_scene_count
        provider_totals[provider]["fallback"] += fallback_scene_count

    for row in scenes:
        run_id = (row.get("run_id") or "unknown").strip() or "unknown"
        passed_visual_review = parse_bool(row.get("passed_visual_review", ""))
        scenes_by_run[run_id].append(row)

        if passed_visual_review is True:
            passed_scene_count += 1
        elif passed_visual_review is False:
            failed_scene_count += 1

        provider = (row.get("provider") or "unknown").strip() or "unknown"
        model = (row.get("model") or "unknown").strip() or "unknown"
        verse_type = (row.get("verse_type") or "unknown").strip() or "unknown"
        model_totals[model]["reviewed"] += 1
        model_totals[model]["avg_quality"] += parse_float(row.get("quality_score", ""))
        if passed_visual_review is True:
            model_totals[model]["passed"] += 1
        elif passed_visual_review is False:
            model_totals[model]["failed"] += 1

        for tag in split_tags(row.get("failure_tags", "")):
            tag_counter[tag] += 1
            run_ids_by_tag[tag].add(run_id)
            scene_class_provider_hits[(tag, verse_type, provider, model)] += 1

    run_rankings: list[tuple[str, float, int, int]] = []
    for run_id, run_scenes in scenes_by_run.items():
        reviewed = 0
        failed = 0
        for row in run_scenes:
            passed_visual_review = parse_bool(row.get("passed_visual_review", ""))
            if passed_visual_review is None:
                continue
            reviewed += 1
            if passed_visual_review is False:
                failed += 1
        failure_ratio = (failed / reviewed) if reviewed else 0.0
        run_rankings.append((run_id, failure_ratio, failed, reviewed))

    best_runs = sorted(run_rankings, key=lambda item: (item[1], item[2], item[0]))[:3]
    worst_runs = sorted(run_rankings, key=lambda item: (-item[1], -item[2], item[0]))[:3]

    intervention_by_runs = sorted(
        ((tag, len(run_ids)) for tag, run_ids in run_ids_by_tag.items() if len(run_ids) >= 3),
        key=lambda item: (-item[1], item[0]),
    )
    intervention_by_scene_class = sorted(
        (
            (tag, verse_type, provider, model, count)
            for (tag, verse_type, provider, model), count in scene_class_provider_hits.items()
            if count >= 2
        ),
        key=lambda item: (-item[4], item[0], item[1], item[2], item[3]),
    )

    decision_counter: Counter[str] = Counter()
    for row in runs:
        decision = (row.get("decision") or "pending_review").strip() or "pending_review"
        decision_counter[decision] += 1

    print("quality_tracking_summary")
    print(f"runs={total_runs}")
    print(f"scenes={total_scenes}")
    print(f"reviewed_scenes={len(scenes)}")
    print(f"passed_visual_review={passed_scene_count}")
    print(f"failed_visual_review={failed_scene_count}")
    print(f"degraded_rate={degraded_rate:.2%}")
    print(f"fallback_rate={fallback_rate:.2%}")
    if like_rate is None:
        print("like_rate=n/a")
    else:
        print(f"like_rate={like_rate:.2%}")

    print("top_failure_tags")
    if not tag_counter:
        print("- none")
    else:
        for tag, count in tag_counter.most_common(5):
            print(f"- {tag}: {count}")

    print_ranked_runs("best_runs", best_runs)
    print_ranked_runs("worst_runs", worst_runs)

    print("intervention_candidates_by_runs")
    if not intervention_by_runs:
        print("- none")
    else:
        for tag, run_count in intervention_by_runs:
            print(f"- {tag}: distinct_runs={run_count} threshold=3")

    print("intervention_candidates_by_scene_class_provider")
    if not intervention_by_scene_class:
        print("- none")
    else:
        for tag, verse_type, provider, model, count in intervention_by_scene_class:
            print(
                f"- {tag}: verse_type={verse_type} provider={provider} "
                f"model={model} hits={count} threshold=2"
            )

    print("style_breakdown")
    for style, metrics in sorted(style_totals.items()):
        scenes_total = int(metrics["scenes"])
        degraded = int(metrics["degraded"])
        fallback = int(metrics["fallback"])
        degraded_rate_by_style = (degraded / scenes_total) if scenes_total else 0.0
        fallback_rate_by_style = (fallback / scenes_total) if scenes_total else 0.0
        print(
            f"- {style}: runs={int(metrics['runs'])} scenes={scenes_total} "
            f"degraded_rate={degraded_rate_by_style:.2%} fallback_rate={fallback_rate_by_style:.2%}"
        )

    print("provider_breakdown")
    for provider, metrics in sorted(provider_totals.items()):
        scenes_total = int(metrics["scenes"])
        degraded = int(metrics["degraded"])
        fallback = int(metrics["fallback"])
        degraded_rate_by_provider = (degraded / scenes_total) if scenes_total else 0.0
        fallback_rate_by_provider = (fallback / scenes_total) if scenes_total else 0.0
        print(
            f"- {provider}: runs={int(metrics['runs'])} scenes={scenes_total} "
            f"degraded_rate={degraded_rate_by_provider:.2%} fallback_rate={fallback_rate_by_provider:.2%}"
        )

    print("model_breakdown")
    for model, metrics in sorted(model_totals.items()):
        reviewed = int(metrics["reviewed"])
        passed = int(metrics["passed"])
        failed = int(metrics["failed"])
        pass_rate = (passed / reviewed) if reviewed else 0.0
        avg_quality = (metrics["avg_quality"] / reviewed) if reviewed else 0.0
        print(
            f"- {model}: reviewed={reviewed} pass_rate={pass_rate:.2%} "
            f"failed={failed} avg_quality={avg_quality:.2f}"
        )

    print("decision_breakdown")
    for decision, count in decision_counter.most_common():
        print(f"- {decision}: {count}")


if __name__ == "__main__":
    main()

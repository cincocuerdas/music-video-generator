#!/usr/bin/env python3
"""
Inspect latest project, analysis and jobs from the database.
"""

from __future__ import annotations

import json

from db_utils import get_db_connection
from script_logging import fail, info, ok, section


def check() -> None:
    section("LATEST PROJECT DEBUG", width=60)

    try:
        conn = get_db_connection()
    except Exception:
        fail("DATABASE_URL not found or DB unavailable")
        return

    cur = conn.cursor()
    cur.execute(
        'SELECT id, title, status, "analysisResult", "videoUrl" FROM "Project" ORDER BY "createdAt" DESC LIMIT 1',
    )
    project = cur.fetchone()

    if not project:
        fail("No projects found")
        cur.close()
        conn.close()
        return

    ok(f"Project: {project[1]} ({project[0]})")
    info(f"Status: {project[2]}")
    info(f"Video URL: {project[4]}")

    analysis = project[3]
    if analysis:
        if isinstance(analysis, str):
            analysis = json.loads(analysis)
        scenes = analysis.get("scenes", [])
        images = analysis.get("generatedImages", [])
        total_duration = 0.0
        if scenes:
            start = scenes[0].get("startTime", 0)
            end = scenes[-1].get("endTime", start + scenes[-1].get("duration", 5))
            total_duration = float(end)

        info(f"Scenes: {len(scenes)}")
        info(f"Analysis duration: {total_duration:.2f}s")
        info(f"Generated images: {len(images)}")

        failed_images = [img for img in images if img.get("status") != "success"]
        info(f"Failed images: {len(failed_images)}")
        if failed_images:
            fail(f"First image failure: {failed_images[0].get('error')}")

    cur.execute(
        'SELECT type, status, progress, "currentStep", "errorMessage" FROM "Job" '
        'WHERE "projectId" = %s ORDER BY "createdAt" ASC',
        (project[0],),
    )
    jobs = cur.fetchall()
    section("JOB STATUS", width=60)
    for job in jobs:
        print(
            f"[INFO] {job[0]} | status={job[1]} | progress={job[2]}% | "
            f"step={job[3]} | error={job[4]}"
        )

    cur.close()
    conn.close()


if __name__ == "__main__":
    check()


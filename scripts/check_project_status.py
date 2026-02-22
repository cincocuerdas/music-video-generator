#!/usr/bin/env python3
"""
Check status and jobs for a specific project ID (or latest project if omitted).
"""

from __future__ import annotations

import sys

from db_utils import get_db_connection
from script_logging import fail, info, ok, section


def get_latest_project_id() -> str | None:
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('SELECT id FROM "Project" ORDER BY "createdAt" DESC LIMIT 1')
    latest = cur.fetchone()
    cur.close()
    conn.close()
    return latest[0] if latest else None


def check_status(project_id: str) -> None:
    conn = get_db_connection()
    cur = conn.cursor()

    section(f"PROJECT STATUS: {project_id}", width=70)
    cur.execute(
        'SELECT status, "videoUrl", "audioUrl", lyrics FROM "Project" WHERE id = %s',
        (project_id,),
    )
    project = cur.fetchone()
    if not project:
        fail("Project not found")
        cur.close()
        conn.close()
        return

    ok(f"Status: {project[0]}")
    info(f"Audio URL: {project[2]}")
    info(f"Lyrics preview: {(project[3] or 'None')[:50]}...")
    info(f"Video URL: {project[1]}")

    section("ASSOCIATED JOBS", width=70)
    cur.execute(
        'SELECT type, status, progress, "errorMessage", "updatedAt" FROM "Job" '
        'WHERE "projectId" = %s ORDER BY "createdAt" ASC',
        (project_id,),
    )
    jobs = cur.fetchall()
    for job in jobs:
        print(
            f"[INFO] type={job[0]:<20} status={job[1]:<10} progress={job[2]}% "
            f"error={job[3]} updatedAt={job[4]}"
        )

    cur.close()
    conn.close()


if __name__ == "__main__":
    requested_id = sys.argv[1] if len(sys.argv) > 1 else None
    project_id = requested_id or get_latest_project_id()
    if not project_id:
        fail("No projects found")
        sys.exit(1)
    if not requested_id:
        info(f"No project ID provided. Using latest: {project_id}")
    check_status(project_id)


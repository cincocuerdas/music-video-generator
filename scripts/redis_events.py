#!/usr/bin/env python3
"""
Redis Events Publisher

Publishes pipeline events to Redis for real-time WebSocket updates.
Used by generate_images.py and other pipeline scripts.
"""

import json
import os
import sys
from typing import Literal
from dotenv import load_dotenv
from redis_utils import get_redis_client as create_redis_client

# Load .env
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
load_dotenv(os.path.join(root_dir, '.env'))

# Channel for pipeline events
CHANNEL = 'job_events'

# Event types
EventType = Literal[
    'image_generated',
    'frame_skipped',
    'progress',
    'verse_classified',
    'pipeline_complete',
    'steering_applied',      # New: Live steering signal was processed
    'steering_received'      # New: Backend received a steering signal
]


def get_redis_client():
    """Get Redis client from environment."""
    return create_redis_client(log_prefix="redis_events")


def publish_event(
    project_id: str,
    event_type: EventType,
    data: dict
) -> bool:
    """
    Publish a pipeline event to Redis.

    Args:
        project_id: The project ID
        event_type: Type of event
        data: Event data

    Returns:
        True if published to Redis, False if fell back to stdout
    """
    message = {
        "projectId": project_id,
        "type": event_type,
        "data": data
    }

    # Also print for backward compatibility with stdout parsing
    print(f"PROGRESS:{json.dumps({'type': event_type, 'data': data})}")
    sys.stdout.flush()

    # Try to publish to Redis
    client = get_redis_client()
    if client:
        try:
            client.publish(CHANNEL, json.dumps(message))
            return True
        except Exception as e:
            print(f"Warning: Failed to publish to Redis: {e}", file=sys.stderr)

    return False


def emit_image_generated(
    project_id: str,
    scene_index: int,
    total_scenes: int,
    image_url: str,
    prompt: str = "",
    exposed: bool = True,
    verse_type: str = "NARRATIVE"
):
    """Emit IMAGE_GENERATED event."""
    publish_event(project_id, 'image_generated', {
        "sceneIndex": scene_index,
        "totalScenes": total_scenes,
        "imageUrl": image_url,
        "prompt": prompt[:100],
        "exposed": exposed,
        "verseType": verse_type,
        "progress": int(((scene_index + 1) / total_scenes) * 100)
    })


def emit_frame_skipped(
    project_id: str,
    scene_index: int,
    total_scenes: int,
    reason: str
):
    """Emit FRAME_SKIPPED event."""
    publish_event(project_id, 'frame_skipped', {
        "sceneIndex": scene_index,
        "totalScenes": total_scenes,
        "exposed": False,
        "reason": reason,
        "progress": int(((scene_index + 1) / total_scenes) * 100)
    })


def emit_verse_classified(
    project_id: str,
    scene_index: int,
    total_scenes: int,
    verse_type: str
):
    """Emit VERSE_CLASSIFIED event."""
    publish_event(project_id, 'verse_classified', {
        "sceneIndex": scene_index,
        "totalScenes": total_scenes,
        "verseType": verse_type,
        "progress": int((scene_index / max(total_scenes, 1)) * 100)
    })


def emit_progress(
    project_id: str,
    progress: int,
    message: str,
    job_type: str = "GENERATE_IMAGES",
):
    """Emit generic PROGRESS event."""
    publish_event(project_id, 'progress', {
        "progress": progress,
        "message": message,
        "jobType": job_type,
    })


def emit_pipeline_complete(
    project_id: str,
    video_url: str
):
    """Emit PIPELINE_COMPLETE event."""
    publish_event(project_id, 'pipeline_complete', {
        "url": video_url,
        "progress": 100,
        "exposed": True
    })


def emit_steering_applied(
    project_id: str,
    signal_type: str,
    scene_index: int,
    message: str,
    modifications: dict = None
):
    """
    Emit STEERING_APPLIED event when Python processes a live signal.

    This provides feedback to the frontend that the user's direction
    has been acknowledged and applied to the generation.
    """
    publish_event(project_id, 'steering_applied', {
        "signalType": signal_type,
        "sceneIndex": scene_index,
        "message": message,
        "modifications": modifications or {},
        "timestamp": int(__import__('time').time() * 1000)
    })


def emit_steering_received(
    project_id: str,
    signal_type: str,
    scene_index: int
):
    """
    Emit STEERING_RECEIVED event when backend receives a new signal.

    This provides immediate feedback before Python processes it.
    """
    publish_event(project_id, 'steering_received', {
        "signalType": signal_type,
        "sceneIndex": scene_index,
        "status": "queued",
        "timestamp": int(__import__('time').time() * 1000)
    })


# CLI test
if __name__ == "__main__":
    print("Testing Redis connection...")
    client = get_redis_client()
    if client:
        print("Redis connected!")
        # Test publish
        emit_progress("test-project", 50, "Testing...")
        print("Test event published.")
    else:
        print("Redis not available, using stdout only.")

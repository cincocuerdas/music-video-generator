# SmolVLM Usage Matrix

Use `HuggingFaceTB/SmolVLM2-500M-Video-Instruct` only as a low-confidence visual helper.

It is suitable for coarse scene classification and triage. It is not suitable as an automatic quality gate for production decisions.

## Allowed Uses

| Question / Task | Use It? | Expected Confidence | How To Use It |
|---|---|---:|---|
| Is there a crowd? | Yes | Medium | Triage crowd-heavy scenes for manual review. |
| Is there a single human subject? | Yes | Medium | Distinguish portrait vs group scenes. |
| Is there an animal as the main subject? | Yes | Low-Medium | Useful only as a weak second opinion. Confirm manually. |
| Is there readable text/signage? | Yes | Low-Medium | Use as a hint only. Never trust alone for pass/fail. |
| Is this mostly a close-up? | Yes | Medium | Helps classify scene framing for audits. |
| Is the scene wide/environmental? | Yes | Medium | Good for rough scene-type labeling. |
| Is there a human at all? | Yes | Medium | Useful for detecting obvious subject-class mismatch. |
| Is the image mostly object/detail-focused? | Yes | Low-Medium | Use only as a weak signal for `human_detail` vs `portrait_human`. |

## Disallowed Uses

| Question / Task | Use It? | Why Not |
|---|---|---|
| Are the hands anatomically correct? | No | Too weak for fine anatomy judgments. |
| Are mouths, teeth, and lips correct? | No | Unreliable for subtle facial defect detection. |
| Are the eyes clean and symmetric? | No | Too noisy for facial micro-quality. |
| Is identity consistent across scenes? | No | Not strong enough for cross-frame identity checks. |
| Does this scene fully satisfy the lyric meaning? | No | Semantic/narrative judgment is too complex. |
| Should this scene pass or fail automatically? | No | This model is not stable enough for production gates. |
| Should quality score be penalized automatically? | No | Too many false positives and false negatives. |
| Is a full final video correct for a single scene prompt? | No | Multiscene videos confuse the model. |

## Recommended Workflow

1. Run it on single scene images or short scene-level clips only.
2. Ask 1-3 binary questions at most.
3. Treat answers as triage hints, not verdicts.
4. If the answer matters to product quality, confirm manually.
5. Never use SmolVLM alone to alter provider routing, degrade status, fallback status, or quality score.

## Good Questions

- `Is there a crowd in this image?`
- `Is the main subject human?`
- `Is there readable text in the image?`
- `Is this a close-up shot?`
- `Is there an animal as the main subject?`

## Bad Questions

- `Are the hands high quality?`
- `Are the mouths and teeth natural?`
- `Does this image capture the emotional meaning of the lyric?`
- `Should this scene be accepted into the final video?`
- `Is this output better than provider X overall?`

## Tracking Policy

If you use SmolVLM results in tracking:

- record them as `auxiliary_signal`
- never as `final_verdict`
- keep human review as the source of truth

Suggested fields:

- `smolvlm_used: true|false`
- `smolvlm_question`
- `smolvlm_answer`
- `smolvlm_confidence`
- `smolvlm_confirmed_by_human: true|false`

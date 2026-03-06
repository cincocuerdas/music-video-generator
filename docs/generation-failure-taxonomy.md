# Generation Failure Taxonomy

Use these tags when auditing generated images and videos. The point is to classify failures by system layer, not by vague aesthetics.

## 1. Prompt Layer

| Tag | Meaning |
|-----|---------|
| `prompt_under_specified` | Prompt lacks enough subject, setting, anatomy, or shot detail. |
| `prompt_over_complex` | Prompt asks for too many subjects, actions, or visual demands at once. |
| `prompt_conflicting_intent` | Prompt mixes incompatible scene goals or styles. |
| `prompt_missing_negative_guidance` | Prompt needed explicit avoidance guidance and did not have it. |
| `prompt_text_not_explicit` | Text or signage mattered but prompt did not state it clearly enough. |
| `prompt_action_not_explicit` | Action scene required pose/motion guidance and did not have it. |

## 2. Routing Layer

| Tag | Meaning |
|-----|---------|
| `routing_wrong_provider` | A different provider should have been selected for this scene. |
| `routing_missed_trait` | Trait detection failed to classify the scene correctly. |
| `routing_failed_over_too_early` | Provider failover happened before primary provider had a fair chance. |
| `routing_stayed_too_long` | System kept using a weak provider for a difficult scene. |

## 3. Provider / Model Layer

| Tag | Meaning |
|-----|---------|
| `provider_limit_text_render` | Provider cannot reliably render text or signage for this scene. |
| `provider_limit_multi_person` | Provider breaks down with many people or complex staging. |
| `provider_limit_action_pose` | Provider fails on dynamic poses or action composition. |
| `provider_limit_anatomy` | Provider produces unstable human anatomy for the requested scene. |
| `provider_limit_background_faces` | Provider distorts people in secondary/background positions. |
| `provider_rate_limit_side_effect` | 429/cooldown/failover likely degraded scene quality indirectly. |

## 4. Visual Defect Layer

| Tag | Meaning |
|-----|---------|
| `face_distortion` | Main face is visibly malformed. |
| `mouth_distortion` | Mouth or teeth are visibly wrong. |
| `eye_distortion` | Eyes, gaze, or eyelids are visibly wrong. |
| `hand_distortion` | Fingers, palms, or wrist pose are visibly wrong. |
| `limb_distortion` | Arms, legs, elbows, or shoulders are visibly wrong. |
| `background_face_distortion` | Secondary/background faces are visibly broken. |
| `clothing_artifact` | Clothes merge incorrectly or contain broken geometry. |
| `object_artifact` | Important object is malformed or merged with another subject. |
| `text_render_failure` | Text is gibberish, broken, or unreadable where it mattered. |
| `crowd_composition_failure` | Group arrangement is unnatural or collapses into noise. |
| `action_pose_failure` | Pose does not read as the intended movement or action. |
| `environment_incoherence` | Setting or background does not match the scene intent. |
| `identity_drift` | Subject identity changes scene to scene when continuity mattered. |

## 5. Pipeline / Quality Layer

| Tag | Meaning |
|-----|---------|
| `quality_gate_missed_bad_output` | Scene should have been penalized or retried and was not. |
| `fallback_overuse` | Fallback provider or placeholder was used too often. |
| `degraded_hidden_cost` | Scene technically completed, but quality loss is functionally unacceptable. |
| `exposure_bad_anchor_choice` | Frame exposer chose a weak anchor frame. |
| `continuity_break` | Output is individually plausible but breaks video continuity. |

## 6. Root Cause Mapping

Use this mapping when proposing fixes:

| Primary failure type | First fix to try |
|----------------------|------------------|
| Prompt tags dominate | improve prompt template / trait instructions |
| Routing tags dominate | improve trait detection or provider routing |
| Provider tags dominate | change provider or reduce scene complexity |
| Visual defect tags dominate | add scene-specific anatomy rules or quality penalties |
| Pipeline tags dominate | adjust retry, failover, or quality gate thresholds |

## 7. Minimum Audit Output

For every bad scene, record:

1. one primary tag
2. one secondary tag if needed
3. one guessed root cause
4. one concrete corrective action

# Database — Relationships (generated)

> Regenerate with `npm run db:docs`. Foreign keys only (child → parent).

| Child table | Column | → | Parent table | Column | ON DELETE |
|---|---|---|---|---|---|
| `ai_insights` | `group_id` | → | `groups` | `id` | SET NULL |
| `ai_insights` | `report_id` | → | `ai_reports` | `id` | CASCADE |
| `ai_reports` | `group_id` | → | `groups` | `id` | CASCADE |
| `broadcast_button_clicks` | `broadcast_id` | → | `broadcasts` | `id` | CASCADE |
| `broadcast_deliveries` | `broadcast_id` | → | `broadcasts` | `id` | CASCADE |
| `chat_logs` | `group_id` | → | `groups` | `id` | CASCADE |
| `chat_message_annotations` | `chat_log_id` | → | `chat_logs` | `id` | CASCADE |
| `datatruck_document_deliveries` | `group_id` | → | `groups` | `id` | SET NULL |
| `dispatch_eta_updates` | `group_id` | → | `groups` | `id` | CASCADE |
| `dispatch_team_drivers` | `driver_profile_id` | → | `driver_profiles` | `id` | SET NULL |
| `dispatch_team_drivers` | `group_id` | → | `groups` | `id` | SET NULL |
| `dispatch_team_drivers` | `team_id` | → | `dispatch_teams` | `id` | CASCADE |
| `dispatch_team_members` | `team_id` | → | `dispatch_teams` | `id` | CASCADE |
| `driver_home_status` | `group_id` | → | `groups` | `id` | CASCADE |
| `driver_location_checkins` | `group_id` | → | `groups` | `id` | CASCADE |
| `driver_location_checkins` | `monitor_id` | → | `driver_location_monitors` | `id` | CASCADE |
| `driver_location_monitors` | `group_id` | → | `groups` | `id` | CASCADE |
| `driver_profiles` | `group_id` | → | `groups` | `id` | CASCADE |
| `driver_road_history` | `group_id` | → | `groups` | `id` | CASCADE |
| `employee_votes` | `option_id` | → | `employee_votes_options` | `id` | CASCADE |
| `employee_votes` | `poll_id` | → | `employee_votes_polls` | `id` | CASCADE |
| `employee_votes_options` | `group_id` | → | `groups` | `id` | SET NULL |
| `employee_votes_options` | `poll_id` | → | `employee_votes_polls` | `id` | CASCADE |
| `facebook_connect_sessions` | `group_id` | → | `groups` | `id` | CASCADE |
| `facebook_lead_auto_message_rules` | `settings_id` | → | `facebook_lead_auto_message_settings` | `id` | CASCADE |
| `facebook_page_connections` | `group_id` | → | `groups` | `id` | CASCADE |
| `fuel_monitor_inbox` | `alert_id` | → | `fuel_stop_alerts` | `id` | SET NULL |
| `fuel_monitor_inbox` | `group_id` | → | `groups` | `id` | CASCADE |
| `fuel_stop_alerts` | `group_id` | → | `groups` | `id` | CASCADE |
| `group_members` | `group_id` | → | `groups` | `id` | CASCADE |
| `group_pinned_messages` | `group_id` | → | `groups` | `id` | CASCADE |
| `group_recent_loads` | `group_id` | → | `groups` | `id` | CASCADE |
| `home_time_requests` | `group_id` | → | `groups` | `id` | SET NULL |
| `option_translations` | `option_id` | → | `options` | `id` | CASCADE |
| `options` | `question_id` | → | `questions` | `id` | CASCADE |
| `question_media` | `question_id` | → | `questions` | `id` | CASCADE |
| `question_translations` | `question_id` | → | `questions` | `id` | CASCADE |
| `raise_otp` | `round_id` | → | `raise_rounds` | `id` | CASCADE |
| `raise_otp` | `team_id` | → | `dispatch_teams` | `id` | SET NULL |
| `raise_round_picks` | `round_id` | → | `raise_rounds` | `id` | CASCADE |
| `raise_round_picks` | `submission_id` | → | `raise_round_submissions` | `id` | CASCADE |
| `raise_round_picks` | `team_id` | → | `dispatch_teams` | `id` | CASCADE |
| `raise_round_submissions` | `round_id` | → | `raise_rounds` | `id` | CASCADE |
| `raise_round_submissions` | `team_id` | → | `dispatch_teams` | `id` | CASCADE |
| `responses` | `driver_id` | → | `drivers` | `id` | CASCADE |
| `responses` | `group_id` | → | `groups` | `id` | CASCADE |
| `responses` | `option_id` | → | `options` | `id` | CASCADE |
| `responses` | `question_id` | → | `questions` | `id` | CASCADE |
| `ringcentral_calls` | `recruiter_id` | → | `recruiters` | `id` | SET NULL |
| `route_assignments` | `group_id` | → | `groups` | `id` | SET NULL |
| `route_monitor_events` | `assignment_id` | → | `route_assignments` | `id` | CASCADE |
| `safety_event_video_jobs` | `music_asset_id` | → | `safety_event_music_assets` | `id` | SET NULL |
| `safety_event_video_settings` | `active_music_asset_id` | → | `safety_event_music_assets` | `id` | SET NULL |
| `sender_role_consensus` | `group_id` | → | `groups` | `id` | CASCADE |

_Total foreign keys: 54_


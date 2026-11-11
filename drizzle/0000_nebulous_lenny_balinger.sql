CREATE TABLE `offramp_mock_state` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`document` text NOT NULL
);

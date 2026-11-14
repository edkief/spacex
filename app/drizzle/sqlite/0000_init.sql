CREATE TABLE `cargo_items` (
	`id` text PRIMARY KEY NOT NULL,
	`ship_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`quantity` integer NOT NULL,
	FOREIGN KEY (`ship_id`) REFERENCES `ships`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cargo_items_quantity_positive" CHECK("cargo_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cargo_items_ship_resource_unique` ON `cargo_items` (`ship_id`,`resource_type`);--> statement-breakpoint
CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`callsign` text NOT NULL,
	`credits` integer DEFAULT 500 NOT NULL,
	`home_system_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "players_credits_nonneg" CHECK("players"."credits" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_callsign_unique` ON `players` (`callsign`);--> statement-breakpoint
CREATE TABLE `resource_node_state` (
	`node_id` text PRIMARY KEY NOT NULL,
	`system_id` text NOT NULL,
	`quantity_remaining` integer NOT NULL,
	`respawn_at` integer,
	CONSTRAINT "resource_node_state_quantity_nonneg" CHECK("resource_node_state"."quantity_remaining" >= 0)
);
--> statement-breakpoint
CREATE INDEX `resource_node_state_system_idx` ON `resource_node_state` (`system_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`system_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_player_idx` ON `sessions` (`player_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `ships` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`class_id` text NOT NULL,
	`livery` text NOT NULL,
	`hull` real NOT NULL,
	`shields` real NOT NULL,
	`position` text NOT NULL,
	`velocity` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ships_class_valid" CHECK("ships"."class_id" in ('scout', 'freighter', 'interceptor')),
	CONSTRAINT "ships_state_valid" CHECK("ships"."state" in ('docked', 'flying', 'onfoot', 'destroyed')),
	CONSTRAINT "ships_stats_nonneg" CHECK("ships"."hull" >= 0 and "ships"."shields" >= 0)
);
--> statement-breakpoint
CREATE INDEX `ships_owner_idx` ON `ships` (`owner_id`);--> statement-breakpoint
CREATE TABLE `system_registry` (
	`system_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`shard_active` integer DEFAULT false NOT NULL,
	`last_active_at` integer
);

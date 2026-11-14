CREATE TABLE "cargo_items" (
	"id" text PRIMARY KEY NOT NULL,
	"ship_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "cargo_items_ship_resource_unique" UNIQUE("ship_id","resource_type"),
	CONSTRAINT "cargo_items_quantity_positive" CHECK ("cargo_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" text PRIMARY KEY NOT NULL,
	"callsign" text NOT NULL,
	"credits" integer DEFAULT 500 NOT NULL,
	"home_system_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "players_callsign_unique" UNIQUE("callsign"),
	CONSTRAINT "players_credits_nonneg" CHECK ("players"."credits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "resource_node_state" (
	"node_id" text PRIMARY KEY NOT NULL,
	"system_id" text NOT NULL,
	"quantity_remaining" integer NOT NULL,
	"respawn_at" timestamp with time zone,
	CONSTRAINT "resource_node_state_quantity_nonneg" CHECK ("resource_node_state"."quantity_remaining" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"system_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ships" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"class_id" text NOT NULL,
	"livery" jsonb NOT NULL,
	"hull" double precision NOT NULL,
	"shields" double precision NOT NULL,
	"position" jsonb NOT NULL,
	"velocity" jsonb NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ships_class_valid" CHECK ("ships"."class_id" in ('scout', 'freighter', 'interceptor')),
	CONSTRAINT "ships_state_valid" CHECK ("ships"."state" in ('docked', 'flying', 'onfoot', 'destroyed')),
	CONSTRAINT "ships_stats_nonneg" CHECK ("ships"."hull" >= 0 and "ships"."shields" >= 0)
);
--> statement-breakpoint
CREATE TABLE "system_registry" (
	"system_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"shard_active" boolean DEFAULT false NOT NULL,
	"last_active_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cargo_items" ADD CONSTRAINT "cargo_items_ship_id_ships_id_fk" FOREIGN KEY ("ship_id") REFERENCES "public"."ships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ships" ADD CONSTRAINT "ships_owner_id_players_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_node_state_system_idx" ON "resource_node_state" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX "sessions_player_idx" ON "sessions" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ships_owner_idx" ON "ships" USING btree ("owner_id");
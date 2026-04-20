CREATE TABLE "live_transcription_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" varchar(30) DEFAULT 'created' NOT NULL,
	"provider" varchar(100) DEFAULT 'whisperlive' NOT NULL,
	"model" varchar(100),
	"language" varchar(20),
	"detected_language" varchar(20),
	"started_at" timestamp DEFAULT now() NOT NULL,
	"stopped_at" timestamp,
	"finalized_at" timestamp,
	"duration" integer,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(100),
	"error_message" text,
	"recording_id" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_transcription_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"seq" integer NOT NULL,
	"segment_seq" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"text" text NOT NULL,
	"is_final" boolean DEFAULT false NOT NULL,
	"language" varchar(20),
	"confidence" real,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "live_transcription_segments_session_id_seq_unique" UNIQUE("session_id","seq")
);
--> statement-breakpoint
ALTER TABLE "live_transcription_sessions" ADD CONSTRAINT "live_transcription_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "live_transcription_sessions" ADD CONSTRAINT "live_transcription_sessions_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "live_transcription_segments" ADD CONSTRAINT "live_transcription_segments_session_id_live_transcription_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_transcription_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "live_transcription_segments" ADD CONSTRAINT "live_transcription_segments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "live_transcription_sessions_user_id_idx" ON "live_transcription_sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "live_transcription_sessions_status_idx" ON "live_transcription_sessions" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "live_transcription_sessions_user_id_started_at_idx" ON "live_transcription_sessions" USING btree ("user_id","started_at");
--> statement-breakpoint
CREATE INDEX "live_transcription_segments_session_id_idx" ON "live_transcription_segments" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "live_transcription_segments_user_id_idx" ON "live_transcription_segments" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "live_transcription_segments_session_id_segment_seq_idx" ON "live_transcription_segments" USING btree ("session_id","segment_seq");

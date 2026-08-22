CREATE TABLE "plugin_tables" (
	"plugin_id" text NOT NULL,
	"table_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_tables_plugin_id_table_name_pk" PRIMARY KEY("plugin_id","table_name")
);

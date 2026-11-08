import {
	pgTable,
	text,
	integer,
	bigint,
	boolean,
	timestamp,
	date,
	time,
	interval,
	numeric,
	decimal,
	real,
	doublePrecision,
	json,
	jsonb,
	uuid,
	varchar,
	char,
	pgEnum,
	customType,
	primaryKey,
	foreignKey,
	inet,
	cidr,
	macaddr,
	macaddr8,
	bit,
	point,
	line,
} from "drizzle-orm/pg-core";
import {
	mysqlTable,
	mysqlEnum,
	int,
	tinyint,
	datetime,
	year,
	json as mysqlJson,
	binary,
	blob,
	float as mysqlFloat,
	double as mysqlDouble,
	decimal as mysqlDecimal,
} from "drizzle-orm/mysql-core";
import {
	sqliteTable,
	integer as sqliteInteger,
	text as sqliteText,
	blob as sqliteBlob,
	real as sqliteReal,
	numeric as sqliteNumeric,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const roleEnum = pgEnum("role_enum", ["admin", "user", "guest"]);

// Custom type definition
const customBytea = customType<{ data: Buffer }>({
	dataType() {
		return "bytea";
	},
});

// 1. PostgreSQL Complex Table
export const pgComplexTable = pgTable("pg_complex", {
	id: uuid("id").primaryKey().defaultRandom(),
	tags: text("tags").array(),
	role: roleEnum("role"),
	inlineEnum: text("inline_enum", { enum: ["a", "b", "c"] }),
	pointTuple: point("point_tuple", { mode: "tuple" }),
	pointXy: point("point_xy", { mode: "xy" }),
	lineTuple: line("line_tuple", { mode: "tuple" }),
	inetCol: inet("inet_col"),
	cidrCol: cidr("cidr_col"),
	macCol: macaddr("mac_col"),
	mac8Col: macaddr8("mac8_col"),
	bitCol: bit("bit_col", { dimensions: 8 }),
	tsTzDate: timestamp("ts_tz_date", { withTimezone: true, mode: "date" }),
	tsTzStr: timestamp("ts_tz_str", { withTimezone: true, mode: "string" }),
	dStr: date("d_str", { mode: "string" }),
	dObj: date("d_obj", { mode: "date" }),
	timeCol: time("time_col"),
	intervalCol: interval("interval_col"),
	numCol: numeric("num_col"),
	decCol: decimal("dec_col", { precision: 12, scale: 4 }),
	realCol: real("real_col"),
	dblCol: doublePrecision("dbl_col"),
	bigintNum: bigint("bigint_num", { mode: "number" }),
	bigintBig: bigint("bigint_big", { mode: "bigint" }),
	jsonCol: json("json_col"),
	jsonbCol: jsonb("jsonb_col").$type<{ foo: string; bar: number }>(),
	genCol: integer("gen_col").generatedAlwaysAs(sql`10 + 20`),
	defFn: text("def_fn").$defaultFn(() => "random_id"),
	customByteaCol: customBytea("custom_bytea_col"),
});

// 2. PostgreSQL Composite PK Table
export const pgCompositePkTable = pgTable(
	"pg_composite_pk",
	{
		tenantId: uuid("tenant_id").notNull(),
		userId: integer("user_id").notNull(),
		role: text("role").notNull().default("member"),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.tenantId, table.userId] }),
	}),
);

// 3. MySQL Complex Table
export const mysqlComplexTable = mysqlTable("mysql_complex", {
	id: int("id").primaryKey().autoincrement(),
	status: mysqlEnum("status", ["active", "pending", "disabled"]),
	config: mysqlJson("config"),
	createdAt: datetime("created_at"),
	activeYear: year("active_year"),
	binData: binary("bin_data", { length: 16 }),
	blobData: blob("blob_data"),
	flt: mysqlFloat("flt"),
	dbl: mysqlDouble("dbl"),
	dec: mysqlDecimal("dec", { precision: 8, scale: 2 }),
});

// 4. SQLite Complex Table
export const sqliteComplexTable = sqliteTable("sqlite_complex", {
	id: sqliteInteger("id", { mode: "number" }).primaryKey({
		autoIncrement: true,
	}),
	isFlag: sqliteInteger("is_flag", { mode: "boolean" }),
	ts: sqliteInteger("ts", { mode: "timestamp" }),
	tsMs: sqliteInteger("ts_ms", { mode: "timestamp_ms" }),
	jsonField: sqliteText("json_field", { mode: "json" }),
	enumField: sqliteText("enum_field", { enum: ["low", "medium", "high"] }),
	blobBuf: sqliteBlob("blob_buf", { mode: "buffer" }),
	blobJson: sqliteBlob("blob_json", { mode: "json" }),
	realVal: sqliteReal("real_val"),
	numVal: sqliteNumeric("num_val"),
});

# LadybugDB Cypher Cookbook

A concise guide to Cypher on LadybugDB. Assumes no prior Cypher knowledge. Covers everything used in this project plus the most common patterns you'll need.

---

## 1. Mental Model

Cypher is to graph databases what SQL is to relational databases. The key insight: **joins are expressed as graph patterns** instead of `JOIN ... ON` clauses.

| Concept  | SQL                            | Cypher                                     |
|----------|--------------------------------|--------------------------------------------|
| Read     | `SELECT ... FROM ... WHERE`    | `MATCH ... WHERE ... RETURN`               |
| Write    | `INSERT` / `UPDATE` / `DELETE` | `CREATE` / `SET` / `DELETE`                |
| Grouping | Explicit `GROUP BY`            | **Implicit** — based on what's in `RETURN` |

LadybugDB follows **openCypher** with a structured property model: you must define schemas before inserting data.

---

## 2. Syntax Basics

### Structure

A Cypher statement is composed of **clauses** chained together, terminated by `;`:

```
MATCH (n:Person)          // clause: find pattern
WHERE n.age > 18           // subclause: filter
RETURN n.name, n.age       // clause: project results
ORDER BY n.age DESC        // subclause: sort
LIMIT 10;                  // subclause: cap results
```

### Comments

```cypher
// Single-line comment
/* Multi-line
   comment */
```

### Case Insensitivity

Keywords, table names, column names, and variables are all case-insensitive. `MATCH (a:Person)` = `match (a:person)`.

### Escaping Reserved Keywords

Wrap reserved words in backticks to use them as identifiers:

```cypher
CREATE NODE TABLE `Return` (id INT64 PRIMARY KEY, date TIMESTAMP);
MATCH (n:`Return`) RETURN n.*;
```

### Parameters

Use `$paramName` for runtime placeholders. Always use parameters instead of string interpolation to prevent injection:

```cypher
MATCH (n:Person {name: $name}) RETURN n;
```

---

## 3. Data Types Cheat Sheet

### Primitives (most common)

| Type        | Example                   | Notes                |
|-------------|---------------------------|----------------------|
| `INT64`     | `42`                      | Default integer type |
| `DOUBLE`    | `3.14`                    | Floating point       |
| `BOOLEAN`   | `true` / `false`          |                      |
| `STRING`    | `'hello'`                 | Single quotes, UTF-8 |
| `DATE`      | `date('2022-06-06')`      |                      |
| `TIMESTAMP` | `timestamp('2025-01-01')` | Stored as UTC        |

| `NULL` | Special marker for unknown/missing data |

`null = null` returns `NULL` (not `true`). This is a common gotcha for SQL users where `NULL = NULL` returns `NULL` there too, but Cypher makes it even more explicit: any comparison with `NULL` yields `NULL`. Use `IS NULL` / `IS NOT NULL` to test for nulls.

### Logical types

| Type     | Description                                              |
|----------|----------------------------------------------------------|
| `SERIAL` | Auto-incrementing integer (like `AUTO_INCREMENT`)        |
| `UUID`   | RFC 4122 UUID                                            |
| `JSON`   | Native JSON (v0.15.0+; prefer over STRING for JSON data) |

### Nested types

```cypher
-- STRUCT: fixed keys, all rows share the same keys
STRUCT(first STRING, last STRING)
{first: 'Adam', last: 'Smith'}
full_name.first   -- dot access

-- MAP: variable keys, uniform key/value types
MAP(STRING, INT64)
map(['a', 'b'], [1, 2])

-- UNION: variant type (like std::variant)
UNION(price FLOAT, note STRING)

-- LIST: variable-length, uniform element type
-- ARRAY: fixed-length
```

### Graph types

| Type            | Contains                                         |
|-----------------|--------------------------------------------------|
| `NODE`          | `_ID`, `_LABEL`, plus all properties             |
| `REL`           | `_SRC`, `_DST`, `_ID`, `_LABEL`, plus properties |
| `RECURSIVE_REL` | `_NODES` (LIST[NODE]), `_RELS` (LIST[REL])       |

```cypher
MATCH (a:Person)-[r:Follows]->(b:Person)
RETURN a, r, b;                -- full node & rel objects

MATCH p = (a)-[:Follows]->(b)  -- bind entire path to p
RETURN nodes(p), rels(p);      -- extract nodes/rels from path
```

---

## 4. Query Clauses

### MATCH — Find patterns

The heart of Cypher. Nodes in `()`, relationships in `[]`, labels with `:Type`.

```cypher
-- Find all Person nodes
MATCH (n:Person) RETURN n;

-- Find relationships between nodes
MATCH (a:Person)-[r:Follows]->(b:Person) RETURN a, r, b;

-- Anonymous nodes/rels (no variable binding)
MATCH (:Person)-[:Follows]->(:Person) RETURN count(*);

-- Multi-hop
MATCH (a:Person)-[:Follows]->(b:Person)-[:LivesIn]->(c:City) RETURN a, b, c;

-- Match by property
MATCH (n:Person {name: 'Alice'}) RETURN n;
```

### OPTIONAL MATCH — Left outer join

Returns `NULL` for non-matching parts instead of dropping the entire row:

```cypher
MATCH (c:Character)
OPTIONAL MATCH (c)-[:LOCATED_AT]->(loc:Location)
RETURN c.name, loc.name;
```

**Warning:** Chaining multiple `OPTIONAL MATCH` on the same variable creates a Cartesian product. Use separate queries or `WITH` to avoid this.

### WHERE — Filter

```cypher
MATCH (n:Person)
WHERE n.age >= 18 AND n.name <> 'Player'
RETURN n;

-- Pattern predicates in WHERE
MATCH (m:Message)
WHERE NOT (m)-[:NEXT_MESSAGE]->(:Message)   -- tail of linked list
RETURN m;

-- Label check in WHERE
MATCH (n)
WHERE label(n) = 'Character' OR label(n) = 'Object'
RETURN n;

-- IS NULL
MATCH (n) WHERE n.deleted IS NULL RETURN n;
```

LadybugDB does **not** support `WHERE` inside the pattern itself. This won't work:

```cypher
-- WRONG (Neo4j syntax):
MATCH (n:Person WHERE n.age > 18) RETURN n;
-- RIGHT (LadybugDB):
MATCH (n:Person) WHERE n.age > 18 RETURN n;
```

### RETURN — Project results

```cypher
RETURN n.name, n.age;                    -- specific properties
RETURN n.*;                              -- all properties (excluding _ID, _LABEL)
RETURN n;                                -- full node (STRUCT with _ID, _LABEL, all props)
RETURN count(n) AS cnt;                  -- aggregate with alias
RETURN label(n) AS label, n.name;        -- functions in return
```

### ORDER BY, SKIP, LIMIT

```cypher
ORDER BY n.name DESC, n.age ASC
ORDER BY n._created_at DESC
SKIP 10              -- offset (pagination)
LIMIT 50             -- max rows
```

### WITH — Chain query parts

`WITH` passes results between clauses. Essential for multi-stage queries:

```cypher
MATCH (a:Person)-[:Follows]->(b:Person)
WITH a, count(b) AS follower_count
WHERE follower_count > 5
RETURN a.name, follower_count;
```

### UNWIND — Expand a list into rows

```cypher
UNWIND [1, 2, 3] AS n RETURN n;   -- returns 3 rows: 1, 2, 3
```

Replaces Neo4j's `FOREACH`.

### UNION / UNION ALL — Combine query results

```cypher
MATCH (n:Character) RETURN n.name AS name
UNION ALL
MATCH (n:Location) RETURN n.name AS name;
```

---

## 5. Schema Definition (DDL)

LadybugDB requires a **schema first** approach. Define tables before inserting data.

### Node Tables

```cypher
CREATE NODE TABLE Person (
    uid STRING PRIMARY KEY,
    name STRING,
    age INT64,
    description STRING
);

-- With SERIAL (auto-increment) primary key
CREATE NODE TABLE Person (
    id SERIAL PRIMARY KEY,
    name STRING
);
```

### Relationship Tables

```cypher
CREATE REL TABLE Follows (
    FROM Person TO Person,
    since INT64
);

CREATE REL TABLE LivesIn (
    FROM Person TO City
);
```

### Naming Conventions

Recommended conventions for table names:

| Object              | Convention                    | Good                     | Bad                      |
|---------------------|-------------------------------|--------------------------|--------------------------|
| Node tables         | CamelCase                     | `CarOwner`, `Message`    | `car_owner`, `message`   |
| Relationship tables | CamelCase or UPPER_SNAKE_CASE | `IsPartOf`, `IS_PART_OF` | `isPartOf`, `is_part_of` |

Rules: names must start with an alphabetic/unicode character (not a number), and cannot contain whitespace or special characters other than underscores.

### Alter / Drop

```cypher
ALTER TABLE Person ADD COLUMN email STRING;
DROP TABLE Person;
```

### Subgraphs

```cypher
-- Strictly typed (default): must pre-define all node tables
CREATE GRAPH mygraph;

-- Open type: nodes can be created without pre-defining schemas
-- (compatibility for Neo4j/GQL migrations)
CREATE GRAPH mygraph ANY;
```

---

## 6. Data Manipulation (DML)

Use `CREATE`/`SET`/`DELETE` for small changes. **For bulk inserts, always use `COPY FROM`** — it is orders of magnitude faster than individual `CREATE` statements.

### CREATE — Insert nodes and relationships

```cypher
-- Create a node
CREATE (n:Person {uid: 'alice', name: 'Alice', age: 30});

-- Create a relationship (requires existing nodes)
MATCH (a:Person {uid: 'alice'})
MATCH (b:Person {uid: 'bob'})
CREATE (a)-[r:Follows {since: 2024}]->(b);
```

### MERGE — Create if not exists, match if exists

Idempotent upsert. Always specify labels explicitly.

```cypher
-- Upsert a node
MERGE (n:Person {name: 'Alice'})
ON CREATE SET n.uid = $uid, n._created_at = current_timestamp()
ON MATCH SET n._updated_at = current_timestamp();

-- Upsert a relationship
MATCH (a:Person {name: 'Alice'})
MATCH (b:Person {name: 'Bob'})
MERGE (a)-[r:Follows]->(b)
ON CREATE SET r._created_at = current_timestamp();
```

### SET — Update properties

```cypher
-- Single property
MATCH (n:Person {name: 'Alice'}) SET n.age = 31;

-- Multiple properties
MATCH (n:Person {name: 'Alice'}) SET n.age = 31, n.city = 'Paris';

-- Remove a property (set to NULL)
MATCH (n:Person {name: 'Alice'}) SET n.city = NULL;

-- No += operator for map updates (Neo4j difference)
```

### DELETE — Remove nodes and relationships

```cypher
-- Delete a relationship
MATCH (:Person {name: 'Alice'})-[r:Follows]->(:Person {name: 'Bob'})
DELETE r;

-- Delete a node and all its relationships
MATCH (n:Person {name: 'Alice'})
DETACH DELETE n;

-- Delete with count
MATCH (n:Person {name: 'Alice'})
DETACH DELETE n
RETURN count(n) AS deleted;
```

### LOAD FROM / COPY FROM — Import from files

```cypher
-- Scan a file directly
LOAD FROM 'people.csv' RETURN *;

-- Copy into an existing table (bulk insert)
COPY Person FROM 'people.csv';

-- Copy with options
COPY Person FROM 'people.csv' (HEADER=true, DELIM=',');
```

Replaces Neo4j's `LOAD CSV FROM`. Supports CSV and other formats. `COPY FROM` is the preferred method for bulk data loading — far faster than individual `CREATE` statements.

---

## 7. Expressions & Functions

### Aggregation

Aggregation is **implicit** — no `GROUP BY` needed. Whatever is in `RETURN` that isn't aggregated becomes the grouping key:

```cypher
-- Implicit GROUP BY a.name
MATCH (a:Person)-[:Follows]->(b:Person)
RETURN a.name, count(b) AS follower_count;

-- Aggregates: count(), sum(), avg(), min(), max(), collect()
MATCH (n:Person)
RETURN count(n) AS total, avg(n.age) AS avg_age, collect(n.name) AS names;
```

### Graph Functions

```cypher
label(n)         -- string label of a node
type(r)          -- string type of a relationship
properties(r)    -- map of all properties on a relationship
id(n)            -- internal ID (LadybugDB equivalent of elementId())
nodes(p)         -- list of nodes from a path
rels(p)          -- list of relationships from a path
```

### Temporal Functions

```cypher
current_timestamp()     -- current UTC timestamp (use this, not datetime())
date('2025-06-15')      -- parse a date
timestamp('2025-01-01') -- parse a timestamp
```

### Conditional

```cypher
CASE n.age
  WHEN 18 THEN 'just adult'
  WHEN 65 THEN 'senior'
  ELSE 'other'
END

-- Predicate form:
CASE WHEN n.age < 18 THEN 'minor' ELSE 'adult' END
```

### Pattern Predicates

```cypher
-- NOT with pattern: find nodes missing a relationship
MATCH (m:Message)
WHERE NOT (m)-[:NEXT_MESSAGE]->(:Message)
RETURN m;

-- label() in WHERE
MATCH (n) WHERE label(n) = 'Character' RETURN n;
-- or: MATCH (n:Character) RETURN n;  (preferred)
```

### Coalesce

```cypher
RETURN COALESCE(n.name, n.uid) AS displayName;
```

### Type Checking

```cypher
-- LadybugDB style (NOT neo4j IS :: syntax)
typeOf(n.age) = INT64
```

---

## 8. Subqueries

Subqueries use curly braces `{}` and cannot contain `RETURN`.

### EXISTS — Boolean test

```cypher
MATCH (a:User)
WHERE a.age < 100
  AND EXISTS { MATCH (a)-[:Follows*3..3]->(b:User) }
RETURN a.name;
```

### COUNT — Count matches

```cypher
-- In RETURN
MATCH (a:User)
RETURN a.name, COUNT { MATCH (a)<-[:Follows]-(b:User) } AS followers;

-- In WHERE
MATCH (a:User)
WHERE COUNT { MATCH (a)<-[:Follows]-(b:User) } > 2
RETURN a.name;

-- With DISTINCT (count unique matches)
MATCH (a:User)-[:Follows*1..2]-(b:User)
WHERE a.name = 'Karissa'
RETURN COUNT(DISTINCT b) AS num_unique;
```

---

## 9. Variable-Length Paths

Use the Kleene star `*` with optional bounds:

```cypher
-- Exact length
(a)-[:Follows*3]->(b)

-- Range
(a)-[:Follows*1..5]->(b)

-- Any length (defaults to max 30 if no upper bound)
(a)-[:Follows*]->(b)

-- Shortest path
(a)-[r* SHORTEST 1..10]->(b)
```

**Important:** LadybugDB uses **walk semantics** (repeated edges allowed), unlike Neo4j's **trail semantics** (no repeated edges). Use `is_trail()` or `is_acyclic()` to check path properties if needed.

---

## 10. Transactions

Every statement runs in a transaction. Two modes:

### Auto-commit (default)

Single statements are automatically wrapped:

```cypher
CREATE (a:User {name: 'Alice'});
```

### Manual

```cypher
BEGIN TRANSACTION;
CREATE (a:User {name: 'Alice', age: 72});
MATCH (a:User) RETURN *;
COMMIT;    -- or ROLLBACK to discard

-- Read-only transaction (avoids blocking writes)
BEGIN TRANSACTION READ ONLY;
MATCH (a:User) RETURN *;
COMMIT;
```

**Constraint:** Only one write transaction at a time. Multiple read transactions can run concurrently.

### Checkpoint — Flush WAL to data files

```cypher
CHECKPOINT;
```

Manually merges write-ahead-log (WAL) into database data files. By default, checkpoint happens automatically at the end of a write transaction when the WAL exceeds `CHECKPOINT_THRESHOLD` (default 16MB) and no active transactions exist. Only works when there are no active transactions in the system.

---

## 11. Macros

Define reusable scalar expressions:

```cypher
-- Create
CREATE MACRO addWithDefault(a, b := 3) AS a + b;

-- Use
RETURN addWithDefault(2);      -- 5
RETURN addWithDefault(4, 7);   -- 11

-- With queries
CREATE MACRO case_macro(x) AS CASE x WHEN 35 THEN x + 1 ELSE x - 5 END;
MATCH (a:Person) RETURN case_macro(a.age) AS age;
```

Parameters with defaults must come after required parameters.

---

## 12. Configuration

Use **standalone `CALL`** (cannot be combined with other clauses such as `RETURN`). This is distinct from the `CALL` clause used for system procedures (section 14), which _can_ be chained with `RETURN`.

```cypher
CALL THREADS=5;
CALL TIMEOUT=3000;
CALL var_length_extend_max_depth=10;
CALL progress_bar=true;
CALL checkpoint_threshold=33554432;    -- 32MB
CALL spill_to_disk=true;
```

Key options:

| Option                        | Purpose                  | Default    |
|-------------------------------|--------------------------|------------|
| `THREADS`                     | CPU threads              | system max |
| `TIMEOUT`                     | Query timeout (ms)       | none       |
| `VAR_LENGTH_EXTEND_MAX_DEPTH` | Max recursive depth      | 30         |
| `CHECKPOINT_THRESHOLD`        | WAL size trigger (bytes) | 16MB       |
| `SPILL_TO_DISK`               | Disk spill for COPY FROM | true       |

---

## 13. ATTACH — External Databases

```cypher
ATTACH '/path/to/db' AS alias (dbtype lbug);
MATCH (a:Manager) RETURN *;
DETACH alias;
```

For non-Ladybug databases, install the corresponding extension first.

---

## 14. System Procedures

```cypher
CALL show_tables() RETURN *;
CALL show_functions() RETURN *;
```

---

## 15. Key Differences from Neo4j

| Neo4j                               | LadybugDB                                       |
|-------------------------------------|-------------------------------------------------|
| Schema-optional                     | Schema required (structured property model)     |
| Trail semantics (no repeated edges) | Walk semantics (repeated edges allowed)         |
| `FOREACH`                           | `UNWIND`                                        |
| `REMOVE n.prop`                     | `SET n.prop = NULL`                             |
| `SET n += {map}`                    | Not supported; set properties individually      |
| `n.property IS :: INTEGER`          | `typeOf(n.property) = INT64`                    |
| `elementId(n)`                      | `id(n)`                                         |
| `labels(n)`                         | `label(n)` (singular)                           |
| `toInteger()`, `toFloat()`, etc.    | `cast(value, 'INT64')`, `cast(value, 'DOUBLE')` |
| `LOAD CSV FROM`                     | `LOAD FROM`                                     |
| `WHERE` inside pattern              | Not supported; use `WHERE` after the pattern    |
| `SHOW FUNCTIONS`                    | `CALL show_functions() RETURN *`                |
| `datetime()`                        | `current_timestamp()`                           |
| No upper bound on `*`               | Default max 30 if no bound specified            |
| `FINISH` clause                     | `RETURN COUNT(*)`                               |
| `USE graph`                         | Open a different database instead               |

---

## 16. Common Patterns (from this codebase)

### Upsert a node (MERGE + ON CREATE/MATCH)

```cypher
MERGE (d:Disposition {source_name: $src, target_name: $tgt})
ON CREATE SET d.uid = $uid, d.sentiment = $sentiment, d._created_at = $now
ON MATCH SET d.sentiment = $sentiment, d._updated_at = $now;
```

### Find tail of a linked list

```cypher
MATCH (m:Message)
WHERE NOT (m)-[:NEXT_MESSAGE]->(:Message)
RETURN m;
```

### Auto-increment counter with MERGE

```cypher
MERGE (c:IdCounter {uid: 'counter'})
ON CREATE SET c.value = 0
SET c.value = c.value + 1
RETURN c.value AS value;
```

### Multi-hop with OPTIONAL MATCH (avoid Cartesian product)

```cypher
-- Get characters with location and disposition toward Player
MATCH (c:Character)
OPTIONAL MATCH (c)-[:LOCATED_AT]->(loc:Location)
OPTIONAL MATCH (c)-[:HAS_DISPOSITION]->(d:Disposition {target_name: 'Player'})
RETURN c.name, loc.name, d.sentiment;

-- Warning: chaining OPTIONAL MATCH on (c) creates cross-product.
-- If a character has 2 dispositions and 1 location, you get 2 rows.
-- Use WITH to isolate:
MATCH (c:Character)
OPTIONAL MATCH (c)-[:LOCATED_AT]->(loc:Location)
WITH c, loc
OPTIONAL MATCH (c)-[:HAS_DISPOSITION]->(d:Disposition {target_name: 'Player'})
RETURN c.name, loc.name, d.sentiment;
```

### Dynamic labels with backtick escaping

```cypher
MATCH (n:`${label}`) WHERE n.name = $name RETURN n;
```

### Deletion with count verification

```cypher
MATCH (n:Character {name: $name})
DETACH DELETE n
RETURN count(n) AS deleted;
```

### Schema sync with system procedure

```cypher
CALL show_tables() RETURN *;
```

### Linked list construction (time chain)

```cypher
MATCH (a:TimeAnchor {uid: 'anchor'})
MATCH (a)-[r_del:CURRENT_TIMEPOINT]->(old:TimePoint)
CREATE (new:TimePoint {uid: $uid, day: $day, hour: $hour})
CREATE (old)-[:NEXT_TIMEPOINT]->(new)
CREATE (a)-[:CURRENT_TIMEPOINT]->(new)
DELETE r_del;
```

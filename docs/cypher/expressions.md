# Functions, expressions & operators

You can perform computations using expressions within clauses (e.g., `WHERE`, `WITH`, and `RETURN`) of high-level database query languages like Cypher. Expressions can be very simple or arbitrarily complex. The simplest examples include variables that bind to node and relationship properties, aliases from previous parts of the query, and literals (i.e., constants).

Functions allow you to perform more specific tasks that aren't covered by expressions. Using a combination of logical/arithmetic operators and functions recursively, you can create arbitrarily complex expressions.

The available functions, operators and expressions in Ladybug are organized into the following categories:

---

## Expressions

### Case expressions

Case expressions allow conditional logic in queries, similar to `CASE`/`WHEN`/`THEN`/`ELSE` constructs.

---

## Operators

The following operator categories are available:

- **Comparison operators** — `=`, `<>`, `<`, `>`, `<=`, `>=`
- **Logical operators** — `AND`, `OR`, `XOR`, `NOT`
- **Date operators** — operators for working with `DATE` values
- **Timestamp operators** — operators for working with `TIMESTAMP` values
- **Interval operators** — operators for working with `INTERVAL` values
- **Numeric operators** — `+`, `-`, `*`, `/`, `%`, `^`
- **Null operators** — `IS NULL`, `IS NOT NULL`
- **List operators** — `IN`, `[]` (list access), `+` (list concatenation)

---

## Functions

The following function categories are available:

- **Aggregate functions** — `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `COLLECT`, `percentileCont`, `percentileDisc`, `stDev`, `stDevP`
- **Blob functions** — functions for working with `BLOB` data
- **Casting functions** — `CAST(input, targetType)` for type conversion
- **Date functions** — `current_date()`, `date()` and other date-related functions
- **Timestamp functions** — `current_timestamp()`, `timestamp()` and other timestamp-related functions
- **Interval functions** — functions for working with `INTERVAL` values
- **List functions** — `list_concat`, `list_reverse`, `list_reduce`, `list_extract`, `list_slice`, and others (prefixed with `list_`)
- **Array functions** — `ARRAY_COSINE_SIMILARITY`, `ARRAY_DISTANCE` and other array functions
- **Map functions** — functions for working with `MAP` data
- **Node & relationship functions** — `label()`, `id()`, `nodes()`, `rels()`
- **Numeric functions** — mathematical functions
- **Recursive relationship functions** — `is_trail`, `is_acyclic`
- **Pattern-matching functions** — functions for matching patterns in strings
- **Struct functions** — `struct_extract`, `STRUCT_PACK`
- **Text functions** — string manipulation functions, `size` (for string length)
- **Union functions** — functions for working with `UNION` data types
- **UUID functions** — functions for generating and working with UUIDs
- **Hash functions** — hashing functions
- **Utility functions** — `show_functions()`, `typeOf()` and other utility functions

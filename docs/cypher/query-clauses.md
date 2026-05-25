# Query clauses

## Example database

To demonstrate the use of query clauses in Cypher, we will use the following example graph dataset that consists of `User` and `City` nodes, `Follows` relationships between users, and `LivesIn` relationships between users and cities.

> Refer to the Ladybug documentation for the full example database setup.

## Direct scan clauses

### LOAD FROM

The `LOAD FROM` clause scans data directly from files.

## Reading clauses

The cards below show all clauses that involve reading from a database.

### MATCH

The `MATCH` clause is used to find patterns in the graph. It is the primary way to query graph data.

### OPTIONAL MATCH

The `OPTIONAL MATCH` clause is similar to `MATCH`, but it will return `NULL` for parts of the pattern that are missing, rather than eliminating the row entirely.

### WHERE

The `WHERE` clause filters the results of a `MATCH` clause based on specified conditions.

### WITH

The `WITH` clause allows you to chain multiple query parts together, passing results from one part to the next.

### RETURN

The `RETURN` clause specifies what subset of the matched data to return.

### ORDER BY

The `ORDER BY` clause sorts the result set by one or more properties.

### SKIP

The `SKIP` clause skips a specified number of rows from the beginning of the result set.

### LIMIT

The `LIMIT` clause limits the number of rows returned by a query.

### UNION

The `UNION` clause combines the results of two or more queries.

### UNWIND

The `UNWIND` clause expands a list into a sequence of rows.

### CALL

The `CALL` clause invokes a procedure.

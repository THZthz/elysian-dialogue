# Data definition language

The data definition language (DDL) in Ladybug defines the commands and statements that create, alter, and delete database objects. The schema provides a logical grouping of node and relationship tables, along with their associated properties and data types that define the structure of the graph database.

## Create

The following `CREATE` statements are available in DDL:

### CREATE TABLE

Create table statements for defining node and relationship tables.

```cypher
-- Create a node table
CREATE NODE TABLE Person (
    id SERIAL PRIMARY KEY,
    name STRING,
    age INT64
);

-- Create a relationship table
CREATE REL TABLE Follows (
    FROM Person TO Person,
    since INT64
);
```

## Alter

You can update the schema of a table using `ALTER TABLE`.

## Drop

You can drop tables from the database with `DROP TABLE`.

```cypher
DROP TABLE Person;
```

## Subgraphs

Subgraphs in Ladybug provide isolation and configuration separate from the rest of the system, similar to `CREATE DATABASE` and `USE DATABASE` in relational databases. Each subgraph has its own schema, data, and configuration.

Ladybug supports two types of subgraphs:

- **Strictly typed subgraphs** (default): All nodes must be created using `CREATE NODE TABLE` before they can be used.
- **Open type graphs**: Created via `CREATE GRAPH mygraph ANY`. In open type graphs, you can create nodes with labels without using `CREATE NODE TABLE` first. This provides compatibility for users migrating from GQL or Neo4j.

### CREATE GRAPH

Create subgraph statements.

```cypher
-- Create a strictly typed subgraph (default)
CREATE GRAPH mygraph;

-- Create an open type graph
CREATE GRAPH mygraph ANY;
```

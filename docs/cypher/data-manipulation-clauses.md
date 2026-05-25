# Data manipulation clauses

Ladybug's implementation of openCypher provides `CREATE`/`SET`/`DELETE` commands to manipulate the data in a database. As a general rule, these should be used to do small modifications to the database. For doing large bulk insertions, you should use the `COPY FROM` commands as far as possible.

## CREATE

The `CREATE` clause is used to create nodes and relationships in the graph.

```cypher
-- Create a node
CREATE (a:User {name: 'Alice', age: 72});

-- Create a relationship
CREATE (a)-[:Follows {since: 2024}]->(b);
```

## SET

The `SET` clause is used to update properties on nodes and relationships.

```cypher
MATCH (n:Person {name: 'Alice'})
SET n.age = 35;
```

Properties must be updated in the form of `n.prop = expression`. To remove a property, use `SET n.prop = NULL`.

## DELETE

The `DELETE` clause is used to delete nodes and relationships from the graph.

```cypher
MATCH (n:Person {name: 'Alice'})
DELETE n;
```

## MERGE

The `MERGE` clause is a combination of `MATCH` and `CREATE`. It tries to find a pattern, and if not found, creates it.

## COPY FROM

For bulk data loading, use the `COPY FROM` command:

```cypher
COPY Person FROM 'person.csv';
```

## REMOVE

`REMOVE` is not supported in Ladybug. Use `SET n.prop = NULL` instead.

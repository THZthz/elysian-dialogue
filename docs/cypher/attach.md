# Attach/Detach to External Databases

Using the `ATTACH` statement, you can connect to external Ladybug databases as well as several relational DBMSs. These directories or files of external databases can be either local or in a remote file system. Here is a simple example. Suppose you are in the Ladybug CLI and have opened a database under local directory `/uw`. In the middle of this session, you want to query another local Ladybug database, say `/work`, which supposedly has some `Manager` node table. You can attach to the `/work` database and query the `Manager` nodes in it and then detach as follows:

```cypher
ATTACH '/work' AS work (dbtype lbug);
MATCH (a:Manager) RETURN *;
DETACH work;
```

Except for attaching to local Ladybug databases, attaching to external databases requires installing an extension. Detailed documentation about attaching to external databases can be found under the extensions section of the documentation:

- For attaching to Ladybug databases, see the Ladybug attach documentation
- For attaching to relational databases, see the relational database attach documentation

# Debug endpoint examples — paste-n-run each line separately.
# Assumes server running on localhost:3000.

# Dump all tool schemas (default preset from env, or specify ?preset=)
curl -s -X GET "http://localhost:3000/api/debug/tools"
curl -s -X GET "http://localhost:3000/api/debug/tools?preset=story"
curl -s -X GET "http://localhost:3000/api/debug/tools?preset=pure"

# Render system prompt for each preset
curl -s -X GET "http://localhost:3000/api/debug/prompt"
curl -s -X GET "http://localhost:3000/api/debug/prompt?preset=full"
curl -s -X GET "http://localhost:3000/api/debug/prompt?preset=story"
curl -s -X GET "http://localhost:3000/api/debug/prompt?preset=pure"

# queryWorld — READ
curl -s -X POST "http://localhost:3000/api/debug/tools/queryWorld" -H "Content-Type: application/json" -d '{"action":"READ","query":"MATCH (c:Character) RETURN c.name, c.brief LIMIT 5"}'

# queryWorld — READ: find by keyword
curl -s -X POST "http://localhost:3000/api/debug/tools/queryWorld" -H "Content-Type: application/json" -d '{"action":"READ","query":"MATCH (c:Character) WHERE c.description CONTAINS \"murder\" RETURN c.name, c.brief"}'

# queryWorld — WRITE
curl -s -X POST "http://localhost:3000/api/debug/tools/queryWorld" -H "Content-Type: application/json" -d '{"action":"WRITE","query":"MERGE (c:Character {name: \"Debug_NPC\"}) SET c.brief = \"A debug test character\" RETURN c"}'

# searchWorld
curl -s -X POST "http://localhost:3000/api/debug/tools/searchWorld" -H "Content-Type: application/json" -d '{"query":"weapon","target":"node","domains":["Character","Object"],"limit":3}'

# manageNode — READ
curl -s -X POST "http://localhost:3000/api/debug/tools/manageNode" -H "Content-Type: application/json" -d '{"nodeLabel":"Character","action":"READ","match":{"name":["Player","Crystal vi Elaris"]}}'

# manageNode — UPSERT
curl -s -X POST "http://localhost:3000/api/debug/tools/manageNode" -H "Content-Type: application/json" -d '{"nodeLabel":"Character","action":"UPSERT","match":{"name":"debug_npc"},"properties":{"name":"debug_npc","brief":"Created via debug endpoint"}}'

# manageNode — DELETE
curl -s -X POST "http://localhost:3000/api/debug/tools/manageNode" -H "Content-Type: application/json" -d '{"nodeLabel":"Character","action":"DELETE","match":{"name":"debug_npc"}}'

# manageRelationship — READ (outgoing from one node)
curl -s -X POST "http://localhost:3000/api/debug/tools/manageRelationship" -H "Content-Type: application/json" -d '{"action":"READ","sourceLabel":"Character","sourceMatch":{"name":"Player"},"relationshipType":"CHARACTER_AT"}'

# manageRelationship — READ historical (atTime)
curl -s -X POST "http://localhost:3000/api/debug/tools/manageRelationship" -H "Content-Type: application/json" -d '{"action":"READ","sourceLabel":"Character","sourceMatch":{"name":"Player"},"relationshipType":"CHARACTER_AT","atTime":220}'

# manageRelationship — UPSERT (create)
curl -s -X POST "http://localhost:3000/api/debug/tools/manageRelationship" -H "Content-Type: application/json" -d '{"action":"UPSERT","relationshipType":"CHARACTER_AT","sourceLabel":"Character","sourceMatch":{"name":"Player"},"targetLabel":"Location","targetMatch":{"name":"Observation Car"},"properties":{"brief":"standing by the dome"}}'

# manageRelationship — END (terminate temporal rel)
curl -s -X POST "http://localhost:3000/api/debug/tools/manageRelationship" -H "Content-Type: application/json" -d '{"action":"END","relationshipType":"CHARACTER_AT","sourceLabel":"Character","sourceMatch":{"name":"Debug_NPC"},"targetLabel":"Location","targetMatch":{"name":"Observation Car"},"time":300}'

# manageSchema — register node type
curl -s -X POST "http://localhost:3000/api/debug/tools/manageSchema" -H "Content-Type: application/json" -d '{"target":"NODE","action":"REGISTER","name":"Artifact","description":"A magical or mechanical artifact","properties":[{"name":"power_level","description":"Numeric power rating","tags":["number"]},{"name":"origin","description":"Where it came from","tags":["string"]}]}'

# manageSchema — register relationship type
curl -s -X POST "http://localhost:3000/api/debug/tools/manageSchema" -H "Content-Type: application/json" -d '{"target":"RELATIONSHIP","action":"REGISTER","name":"GUARDS","description":"Character guards a location or object","sourceLabel":"Character","targetLabel":"Location"}'

# editNote — CREATE
curl -s -X POST "http://localhost:3000/api/debug/tools/editNote" -H "Content-Type: application/json" -d '{"noteName":"debug_note","action":"CREATE","content":"A GM scratchpad note from the debug endpoint"}'

# editNote — UPDATE
curl -s -X POST "http://localhost:3000/api/debug/tools/editNote" -H "Content-Type: application/json" -d '{"noteName":"debug_note","action":"UPDATE","content":"Updated note content"}'

# editNote — DELETE
curl -s -X POST "http://localhost:3000/api/debug/tools/editNote" -H "Content-Type: application/json" -d '{"noteName":"debug_note","action":"DELETE"}'

# editPlot — CREATE
curl -s -X POST "http://localhost:3000/api/debug/tools/editPlot" -H "Content-Type: application/json" -d '{"plotName":"debug_plot","action":"CREATE","description":"A test plot from the debug endpoint"}'

# editPlot — UPDATE
curl -s -X POST "http://localhost:3000/api/debug/tools/editPlot" -H "Content-Type: application/json" -d '{"plotName":"debug_plot","action":"UPDATE","status":"COMPLETED"}'

# editPlot — DELETE
curl -s -X POST "http://localhost:3000/api/debug/tools/editPlot" -H "Content-Type: application/json" -d '{"plotName":"debug_plot","action":"DELETE"}'

# getContext — overview
curl -s -X POST "http://localhost:3000/api/debug/tools/getContext" -H "Content-Type: application/json" -d '{"types":["CHARACTERS_BRIEF","LOCATIONS_BRIEF","OBJECTS_BRIEF","PLOTS_BRIEF","SCHEMA_DUMP","RELATIONSHIP_DUMP"]}'

# getContext — TIMELINE
curl -s -X POST "http://localhost:3000/api/debug/tools/getContext" -H "Content-Type: application/json" -d '{"types":["TIMELINE"]}'

# getContext — ENTITY_PROFILE
curl -s -X POST "http://localhost:3000/api/debug/tools/getContext" -H "Content-Type: application/json" -d '{"types":["ENTITY_PROFILE"],"subquery":{"entityName":"Player","entityLabel":"Character"}}'

# getContext — RELATIONSHIP_DUMP with history
curl -s -X POST "http://localhost:3000/api/debug/tools/getContext" -H "Content-Type: application/json" -d '{"types":["RELATIONSHIP_DUMP"],"subquery":{"relationshipHistory":true}}'

# getContext — STORYTELLING_GUIDE sub-prompt
curl -s -X POST "http://localhost:3000/api/debug/tools/getContext" -H "Content-Type: application/json" -d '{"types":["STORYTELLING_GUIDE"],"subquery":{"prompt":"CHARACTER_ARC"}}'

# Reset database
curl -s -X POST "http://localhost:3000/api/reset"

# Logs (SSE) — stream all server logs (past + live)
curl -N -s "http://localhost:3000/api/logs/stream"

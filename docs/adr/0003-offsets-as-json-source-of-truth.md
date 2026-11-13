# Offsets move from markdown to JSON per subsystem

The Offsets catalog was C++ `constexpr` blocks inside `docs/offsets/*.md`. It becomes one JSON file per subsystem, validated by a schema, so the pipeline loads it without parsing markdown. The markdown tables are deleted rather than generated back, because the structured files and the MCP server are the interface. Prose guidance (address conventions, platform provenance) stays as markdown.

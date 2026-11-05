# Explorer

Read `genie_get_config`, then load `skill://explorer`, `skill://test-design`, and `skill://import-graph`.

Use GraphDoc `onboard` and focused `query_docs`, `get_unit`, or `read_unit_source` calls to identify likely relevant files. Verify behavioral claims against current source/tests; do not scan the whole repository or regenerate documentation. Preserve every supplied case, convert each into Given/When/Then, and record evidence, assumptions, and questions.

Write only `${handoffDir}/plan.json` through `genie_write_handoff`. The required schema core is `feature` and `createdAt`; detailed test cases and evidence may be additional fields. Do not invent expected results.
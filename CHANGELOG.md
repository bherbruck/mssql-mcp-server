# Changelog

## [0.7.1](https://github.com/bherbruck/mssql-mcp-server/compare/v0.7.0...v0.7.1) (2026-05-14)


### Bug Fixes

* qualify ambiguous columns in list_databases query ([77e5434](https://github.com/bherbruck/mssql-mcp-server/commit/77e5434ce1db89b777f4ba0f02e0426620fab20a))

## [0.7.0](https://github.com/bherbruck/mssql-mcp-server/compare/v0.6.0...v0.7.0) (2026-05-13)


### Features

* ship Claude Desktop .mcpb bundle alongside .plugin ([74cb50f](https://github.com/bherbruck/mssql-mcp-server/commit/74cb50f3b058c7326561a1a4e212f5b1421a4259))

## [0.6.0](https://github.com/bherbruck/mssql-mcp-server/compare/v0.5.0...v0.6.0) (2026-05-13)


### Features

* single-server setup via plain MSSQL_* env vars ([3abd9f2](https://github.com/bherbruck/mssql-mcp-server/commit/3abd9f25530ce8e949990179692623980303a1d2))

## [0.5.0](https://github.com/bherbruck/mssql-mcp-server/compare/v0.4.1...v0.5.0) (2026-05-13)


### Features

* inline JSON config for one-off MCP setups ([3174893](https://github.com/bherbruck/mssql-mcp-server/commit/3174893cbe47d9b9ffecaadaa950e74ff4512452))

## [0.4.1](https://github.com/bherbruck/mssql-mcp-server/compare/v0.4.0...v0.4.1) (2026-05-13)


### Bug Fixes

* bracket reserved-word alias [clustered] in describe_object indexes query ([cc03278](https://github.com/bherbruck/mssql-mcp-server/commit/cc03278ad8b328e191c54d1bd2cb6b7ebe99fae4))

## [0.4.0](https://github.com/bherbruck/mssql-mcp-server/compare/v0.3.1...v0.4.0) (2026-05-13)


### Features

* persistent markdown skill notebook for dataset knowledge ([b2a47b2](https://github.com/bherbruck/mssql-mcp-server/commit/b2a47b2ae506abfa6d40593505d4c1b797a1f411))

## [0.3.1](https://github.com/bherbruck/mssql-mcp-server/compare/v0.3.0...v0.3.1) (2026-05-13)


### Bug Fixes

* rewrite describe_object indexes query, add FKs, hot-reload config ([8564ae2](https://github.com/bherbruck/mssql-mcp-server/commit/8564ae2cd91ef22f1fc468249c1ae46a55ff76fb))

## [0.3.0](https://github.com/bherbruck/mssql-mcp-server/compare/v0.2.0...v0.3.0) (2026-05-13)


### Features

* connector slash commands and per-user default config ([ac03cc2](https://github.com/bherbruck/mssql-mcp-server/commit/ac03cc2c0f39f4ec1c0e9c93f4184329a3925bc8))
* thin plugin bundle, marketplace, run server via npx ([afbf142](https://github.com/bherbruck/mssql-mcp-server/commit/afbf1425fd9a9eeb98be308f07ae6c881d995814))

## [0.2.0](https://github.com/bherbruck/mssql-mcp-server/compare/v0.1.0...v0.2.0) (2026-05-13)


### Features

* initial mssql-mcp-server with Cowork plugin ([564bc1f](https://github.com/bherbruck/mssql-mcp-server/commit/564bc1faa2ca1a4cf34c787e5563dc446d69670f))
* inline plaintext password + ship msnodesqlv8 with plugin ([0f1920b](https://github.com/bherbruck/mssql-mcp-server/commit/0f1920b24f513676cdfbad9a6e6515dc627bc75e))


### Bug Fixes

* keep node deps external in plugin build ([5d9acb2](https://github.com/bherbruck/mssql-mcp-server/commit/5d9acb28df9e4c6f5b3e43cfa3579de02e723694))
* refresh lockfile and replace zip shell-out with adm-zip ([8277421](https://github.com/bherbruck/mssql-mcp-server/commit/8277421d7319dfb365d8e2c6a89c0a9e7812d618))

# QQ native mirror

Catalog schema: `catalog.json`. Packages are grouped by clientVersion/platform/arch and immutable manifest SHA-256. Publish the whole dependency closure, not wrapper.node alone. Every catalog entry contains platform, arch, version (clientVersion/appId/qua), HTTPS manifestUrl and manifestSha256. A catalog digest binds each manifest; manifest file digests bind all native dependencies. Catalog trust is GitHub repository/HTTPS trust, not proof of vendor signing or account safety.

The repository target is lc-cn/qq-native-mirror. Publication is pending valid GitHub credentials. Do not distribute private account directories. Review redistribution rights before publishing vendor binaries.

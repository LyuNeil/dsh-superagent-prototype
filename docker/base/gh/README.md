# Vendored gh release tarball

Put a GitHub CLI release tarball here (for example `gh_2.60.0_linux_amd64.tar.gz`) and the
base image uses it instead of downloading from GitHub, which can take ten minutes at
~25 KB/s.

```sh
curl -fL -o docker/base/gh/gh_2.60.0_linux_amd64.tar.gz \
  https://github.com/cli/cli/releases/download/v2.60.0/gh_2.60.0_linux_amd64.tar.gz
```

The file matches `gh_<GH_VERSION>_linux_<GH_TARGET_ARCH>.tar.gz`, or the name given by
`GH_LOCAL_TARBALL`. This README is here so the directory exists in a fresh checkout.

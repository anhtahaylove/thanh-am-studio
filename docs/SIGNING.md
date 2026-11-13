# Code signing (SignPath Foundation, planned)

Installers are unsigned today. This page is the checklist for the free open source program of
[SignPath Foundation](https://signpath.org/terms); the policy users see is in the
[README](../README.md#code-signing-policy).

## Eligibility (checked 2026-11-13)

| Condition | State |
|---|---|
| OSI license for all own components, no commercial dual licensing | Apache-2.0 (`LICENSE`, detected by GitHub) |
| No proprietary components in signed packages | Bundled: CPython, FFmpeg (LGPL), Python packages (open source, listed in `sbom.cdx.json`), MSVC C++ runtime DLLs (system libraries, allowed). Models are downloaded by the user, not shipped |
| Released in the form to be signed | NSIS installer on GitHub releases since v0.1.0 |
| Built from source in a verifiable way, GitHub-hosted runners only | `.github/workflows/release.yml` on `windows-latest` from the tag |
| Code signing policy and privacy statement on the home page | README sections "Code signing policy" and "Privacy" |
| Uninstallation | NSIS uninstaller (Windows "Installed apps") |
| No data sent without the user asking | Only user-started model downloads from Hugging Face |
| MFA for every team member on GitHub and SignPath | GitHub two-factor authentication on (owner, 2026-11-13); SignPath account MFA follows approval |

## Owner steps (cannot be delegated)

1. Make sure GitHub two-factor authentication is on for `anhtahaylove`. Done 2026-11-13.
2. Apply at <https://signpath.org/apply> with the repository URL, the release page, and the
   README policy section. Accepting SignPath's terms is the owner's decision. Submitted by the
   owner on 2026-11-13 (category Audio, individual maintainer, GitHub Actions); waiting for
   SignPath's reply by email.
3. After approval: install the [SignPath GitHub App](https://github.com/apps/signpath) on this
   repository, enable MFA on the SignPath account, and create an API token for a submitter user.
4. Store it as the repository secret `SIGNPATH_API_TOKEN`, and the organization id, project slug
   and signing policy slug as repository variables `SIGNPATH_ORGANIZATION_ID`,
   `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG`.

## Workflow change after approval

Sign the installer (the file users download and SmartScreen checks) before the checksums are
computed, in `release.yml` right after `npm run tauri build -- --ci`. The artifact configuration
in SignPath is a single `<pe-file>`; product name "Thanh Âm Studio", product version equal to the tag.

```yaml
      - name: Upload unsigned installer
        id: unsigned
        uses: actions/upload-artifact@v7
        with:
          path: src-tauri/target/release/bundle/nsis/*-setup.exe
          archive: false
      - name: Sign installer (manual approval in SignPath)
        uses: signpath/github-action-submit-signing-request@v3
        with:
          api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
          organization-id: ${{ vars.SIGNPATH_ORGANIZATION_ID }}
          project-slug: ${{ vars.SIGNPATH_PROJECT_SLUG }}
          signing-policy-slug: ${{ vars.SIGNPATH_POLICY_SLUG }}
          github-artifact-id: ${{ steps.unsigned.outputs.artifact-id }}
          wait-for-completion: true
          output-artifact-directory: src-tauri/target/release/bundle/nsis
```

Every release then waits for an approver in SignPath; approve only after the acceptance gates in
[RELEASE.md](RELEASE.md) pass on that build. Afterwards, check the downloaded installer with
`Get-AuthenticodeSignature` (status `Valid`, signer "SignPath Foundation"), update the README
policy and the release notes, and drop the "unsigned" wording from `release.yml`.

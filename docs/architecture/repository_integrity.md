# Repository Integrity

## Boundary

`DeskPet` is not an independent Git repository. The active repository root is:

```text
/path/to/workspace
```

`/path/to/DeskPet` has no nested `.git` directory. The outer repository owns this
source tree.

## Ignore Root Cause

The outer repository uses a deny-by-default `.gitignore`:

```text
*
```

Before P4.3 Completion, `桌宠/DeskPet` was not whitelisted, so sources, tests, docs, scripts and
resources were invisible to Git. The fix adds a narrow whitelist for DeskPet source artifacts while
preserving ignores for build output and runtime state.

## Visible Source Classes

Git can now see:

- `桌宠/DeskPet/Package.swift`
- `桌宠/DeskPet/Sources/**`
- `桌宠/DeskPet/Tests/**`
- `桌宠/DeskPet/docs/**`
- `桌宠/DeskPet/scripts/**`
- `桌宠/DeskPet/Resources/**`
- `桌宠/DeskPet/*.md`

## Ignored Runtime/Build Classes

Git still ignores:

- `桌宠/DeskPet/.build/`
- `桌宠/DeskPet/build/`
- `桌宠/DeskPet/DerivedData/`
- `桌宠/DeskPet/*.app`
- `桌宠/DeskPet/*.dSYM`
- `桌宠/DeskPet/logs/`
- `桌宠/DeskPet/cache/`
- `桌宠/DeskPet/runtime-state/`
- `桌宠/DeskPet/user-data/`
- `桌宠/DeskPet/models/`
- `桌宠/DeskPet/**/*.gguf`
- `桌宠/DeskPet/**/*.bin`
- `桌宠/DeskPet/.DS_Store`

No commit is created by this migration.

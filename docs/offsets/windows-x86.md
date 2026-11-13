# Windows x86 catalog context

This reference describes the provenance and address representation of the bundled domain code examples. Its platform-specific facts apply to that dataset, not to every client supported by the skill's lookup and verification workflow.

| Property               | Catalog target                          |
| ---------------------- | --------------------------------------- |
| Client                 | WoW 3.3.5a, build 12340                 |
| Binary                 | Windows `Wow.exe`                       |
| Architecture           | x86, 32-bit pointers                    |
| Address representation | Preferred-image virtual addresses (VAs) |
| Preferred image base   | `0x00400000`                            |

## Preferred-image VAs

The executable's PE32 header identifies machine `0x014C`, image base `0x00400000`, and entry-point RVA `0x00001000`. That entry point is VA `0x00401000`, matching `WoWOffsets::System::Client::start`. The inspected file's version is `3, 3, 5, 12340`. These header checks establish the address convention; they do not re-verify every catalog label or function signature.

For this dataset, subtract the preferred image base from a catalog VA to obtain an RVA, then add the observed runtime module base. For example, `Lua::FrameScript::Execute` is VA `0x00819210`, so its RVA is `0x00419210`. Adding the module base directly to the catalog value is incorrect.

The following example uses the declarations from [Lua and FrameScript](lua.md). Catalog fragments use `uint32_t`; include `<cstdint>` and make `std::uint32_t` available before those fragments when compiling them.

```cpp
#include <cstdint>

constexpr std::uintptr_t execute_address(std::uintptr_t runtime_base) {
    constexpr std::uintptr_t preferred_image_base = 0x00400000;
    return runtime_base +
        (WoWOffsets::Lua::FrameScript::Execute - preferred_image_base);
}

static_assert(execute_address(0x00400000) == 0x00819210);
```

Obtain `runtime_base` from the target client module. If a loader requires the preferred base, retain that check; address translation alone does not establish that the executable supports rebasing. Follow the shared [verification guidance](address-conventions.md) before calling or hooking an entry.

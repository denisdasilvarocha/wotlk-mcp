# Address conventions and verification

Read this when turning a catalog entry into a runtime address, calling a native function, installing a hook, or researching a missing or uncertain entry. Apply these checks to the selected client platform and binary.

## Establish the address model

Identify the target's executable format, architecture, pointer width, ABI, and build before interpreting an entry. The machine running the analysis can differ from the client being analyzed. The curated catalog is described in [Windows x86 catalog context](windows-x86.md).

Keep file offsets, relative virtual addresses (RVAs), virtual addresses (VAs), object-field offsets, and vtable slots distinct. Determine which representation the selected reference records, then use the target image's load mapping:

- For an RVA, add the runtime base of the image it is relative to.
- For a preferred-image VA, apply the verified relocation or load slide. Where the image uses a uniform slide, this is the catalog VA plus the difference between runtime and preferred bases.
- For a file offset, map through the target format's sections or segments before deriving a runtime address; do not simply add a module base.
- Interpret object-field offsets and vtable slots relative to the matching object's layout and ABI, independently of executable address translation.

Use the target client's module or segment mapping. A plugin or injected library's base is not the client base. Address arithmetic alone does not establish that an image supports relocation or that an entry is valid for a different platform.

## Before calling or hooking

- Match pointer widths and integer representations to the target. A catalog's address storage type is not a function prototype or a universal pointer width.
- Verify the calling convention, parameters, return type, and any `this` pointer against the matching binary before casting or calling an entry. A Lua C callback type is not a generic signature for Lua C API functions such as `PushNumber`.
- Check the relevant instructions and calling context before choosing a hook site. A function address alone does not establish a safe patch boundary.
- Run Lua and game-object operations on the main/game thread. A separate setup or debugging thread does not make those operations safe there.
- Distinguish a global's address from the pointer or value stored there. Read its annotation to determine whether it names a value, pointer, handle, or enum.

## Uncertain entries and additions

The catalog preserves existing IDA annotations, including incorrect historical labels and entries marked absent. These findings are scoped to the dataset's binary and platform. Treat `Not present` entries as lookup records, not callable implementations of the named function. For uncertain labels, the comment's evidence takes precedence over a plausible-looking identifier. Aliases and repeated addresses are not proof that signatures or semantics are identical.

For missing or disputed information, inspect the matching executable in IDA and check the function body and relevant callers or data references. If the database has been rebased, normalize an address to the selected dataset's documented representation before recording it. Record what was established and leave unverified details explicit. If IDA or the matching binary is unavailable, report the verification gap and do not invent an address, prototype, or confirmation.

When adding or correcting an entry in the JSON catalog, retain its path, note, platform provenance, address representation, and verification evidence. Preserve existing names and notes during structural moves, and change their technical meaning only when the evidence supports the correction.

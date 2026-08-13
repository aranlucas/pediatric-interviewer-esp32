#pragma once

// Host clang does not support Xtensa inline assembly. Preserve the ESP32
// configuration while replacing only the interrupt-level assembly used by
// headers pulled into every Arduino translation unit.
#include <xtensa/config/core.h>

#undef XCHAL_HAVE_INTERRUPTS
#define XCHAL_HAVE_INTERRUPTS 0

#include <xtensa/xtruntime.h>

#undef XTOS_RESTORE_INTLEVEL
#undef XTOS_RESTORE_JUST_INTLEVEL
#undef XTOS_SET_INTLEVEL
#undef XTOS_SET_MIN_INTLEVEL
#define XTOS_SET_INTLEVEL(intlevel) (static_cast<unsigned>(intlevel))
#define XTOS_SET_MIN_INTLEVEL(intlevel) (static_cast<unsigned>(intlevel))
#define XTOS_RESTORE_INTLEVEL(restoreval) ((void)(restoreval))
#define XTOS_RESTORE_JUST_INTLEVEL(restoreval) ((void)(restoreval))

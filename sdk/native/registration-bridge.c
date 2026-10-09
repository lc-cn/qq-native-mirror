#include <node_api.h>
#include <dlfcn.h>
#include <stdlib.h>

// QQ's verified macOS and Linux wrappers import this alias in place of standard N-API registration.
// Its module descriptor is the standard napi_module layout.
__attribute__((visibility("default")))
void qq_magic_napi_register(napi_module *module) {
  napi_module_register(module);
}

// Load an explicitly selected system dependency into the process symbol scope.
// Handles intentionally remain open for the lifetime of the owning Node process.
static napi_value preload_library(napi_env env, napi_callback_info info) {
  size_t argc = 1, length = 0;
  napi_value argument, result;
  if (napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_string_utf8(env, argument, NULL, 0, &length) != napi_ok) {
    napi_throw_type_error(env, NULL, "preloadLibrary requires a library path string");
    return NULL;
  }
  char *path = malloc(length + 1);
  if (!path) { napi_throw_error(env, NULL, "Library path allocation failed"); return NULL; }
  if (napi_get_value_string_utf8(env, argument, path, length + 1, &length) != napi_ok) {
    free(path); napi_throw_error(env, NULL, "Unable to read library path"); return NULL;
  }
  void *handle = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
  free(path);
  if (!handle) { napi_throw_error(env, NULL, dlerror()); return NULL; }
  napi_get_undefined(env, &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor property = { "preloadLibrary", NULL, preload_library, NULL, NULL, NULL, napi_default, NULL };
  if (napi_define_properties(env, exports, 1, &property) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)

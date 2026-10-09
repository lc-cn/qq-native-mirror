// Build only against the exact running Node source + matching config.gypi.
// This is an internal-ABI adapter, not an N-API-stable interface.
#include "env-inl.h"
static_assert(OPENSSL_VERSION_MAJOR == 3, "Match official Node OpenSSL layout");
static_assert(_ITERATOR_DEBUG_LEVEL == 0, "Match official Node Release STL layout");
extern "C" __declspec(dllexport)
bool qq_node_environment_stopping(v8::Isolate* isolate) {
  if (isolate == nullptr || !isolate->InContext()) return true;
  v8::HandleScope scope(isolate);
  node::Environment* env = node::GetCurrentEnvironment(isolate->GetCurrentContext());
  return env == nullptr || env->is_stopping();
}

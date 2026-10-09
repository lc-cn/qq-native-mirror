// Dedicated-process probe only. Never load QQ or invoke this in an application.
// Compile as an independent .node against the exact official Node24.20 headers
// and node.lib. Load the already-built sibling QQNT.dll; this validates its code,
// rather than recompiling a separate copy of the adapter implementation.
#include <windows.h>
#include <node_api.h>
#include <node.h>
#include <v8.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>

using Adapter = bool (*)(v8::Isolate*);
static napi_value Verify(napi_env napi, napi_callback_info) {
  // Absolute DLL location is supplied by the dedicated runner, not DLL search.
  wchar_t path[32768];
  DWORD length = GetEnvironmentVariableW(L"QQ_STOPPING_ADAPTER_DLL", path, 32768);
  if (length == 0 || length >= 32768) {
    napi_throw_error(napi, nullptr, "Missing absolute QQ_STOPPING_ADAPTER_DLL");
    return nullptr;
  }
  HMODULE library = LoadLibraryExW(path, nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR |
                                                LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  if (library == nullptr) {
    napi_throw_error(napi, nullptr, "Adapter DLL load failed");
    return nullptr;
  }
  auto adapter = reinterpret_cast<Adapter>(
      GetProcAddress(library, "qq_node_environment_stopping"));
  if (adapter == nullptr) {
    napi_throw_error(napi, nullptr, "Adapter export missing");
    return nullptr;
  }
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  if (isolate == nullptr || !isolate->InContext()) {
    napi_throw_error(napi, nullptr, "No current live Node isolate/context");
    return nullptr;
  }
  node::Environment* environment =
      node::GetCurrentEnvironment(isolate->GetCurrentContext());
  if (environment == nullptr) {
    napi_throw_error(napi, nullptr, "No current Node environment");
    return nullptr;
  }
  const bool nullIsStopping = adapter(nullptr);
  const bool liveIsStopping = adapter(isolate);
  // Public real lifecycle transition; no writes to private fields.
  const int stopResult = node::Stop(
      environment, node::StopFlags::kDoNotTerminateIsolate);
  const bool stoppedIsStopping = adapter(isolate);
  const bool passed = nullIsStopping && !liveIsStopping &&
                      stopResult == 0 && stoppedIsStopping;
  // Do not invoke N-API or attempt to resume JavaScript after Stop.
  std::printf("{\"probe\":\"real-node-stopping-transition\","
              "\"nullIsStopping\":%s,\"liveIsStopping\":%s,"
              "\"stopReturnedZero\":%s,\"stoppedIsStopping\":%s,"
              "\"passed\":%s,\"qqLoaded\":false,"
              "\"accountAccessed\":false,\"normalCloseVerified\":false}\n",
              nullIsStopping ? "true" : "false",
              liveIsStopping ? "true" : "false",
              stopResult == 0 ? "true" : "false",
              stoppedIsStopping ? "true" : "false",
              passed ? "true" : "false");
  std::fflush(stdout);
  // Deliberate dedicated-probe exit; no normal shutdown acceptance claim.
  std::_Exit(passed ? 0 : 1);
}
static napi_value Initialize(napi_env env, napi_value exports) {
  napi_value callback;
  if (napi_create_function(env, "verify", NAPI_AUTO_LENGTH, Verify, nullptr,
                           &callback) != napi_ok ||
      napi_set_named_property(env, exports, "verify", callback) != napi_ok)
    return nullptr;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)

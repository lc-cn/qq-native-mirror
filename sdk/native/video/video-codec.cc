// SPDX-License-Identifier: MIT
// Copyright (c) 2026 qq-native-client contributors
// Standard Node-API only. No QQ, Electron, UI, network or subprocess dependency.
#include <node_api.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/error.h>
#include <libavutil/mathematics.h>
#include <libswscale/swscale.h>
}

namespace {
struct Request {
  napi_async_work work{};
  napi_deferred deferred{};
  std::string path, error;
  int width = 0, height = 0;
  double duration = 0;
  std::vector<uint8_t> image;
  std::chrono::steady_clock::time_point deadline;
};
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void ffcheck(int value, const char* message) { if (value < 0) throw std::runtime_error(message); }
void checked(napi_status status) { if (status != napi_ok) throw std::runtime_error("Node-API video result allocation failed"); }
int interrupted(void* data) { return std::chrono::steady_clock::now() >= static_cast<Request*>(data)->deadline; }
struct Media {
  AVFormatContext* format = nullptr;
  AVCodecContext* codec = nullptr;
  AVFrame* frame = nullptr;
  AVPacket* packet = nullptr;
  SwsContext* scale = nullptr;
  bool opened = false;
  ~Media() {
    sws_freeContext(scale);
    av_packet_free(&packet); av_frame_free(&frame); avcodec_free_context(&codec);
    if (opened) avformat_close_input(&format); else avformat_free_context(format);
  }
};
void le16(std::vector<uint8_t>& b, size_t at, uint16_t value) { b[at] = value & 255; b[at+1] = value >> 8; }
void le32(std::vector<uint8_t>& b, size_t at, uint32_t value) { for (int i = 0; i < 4; i++) b[at+i] = (value >> (8*i)) & 255; }
void decode(Request& request) {
  require(std::filesystem::is_regular_file(std::filesystem::u8path(request.path)), "Video input must be a local regular file");
  request.deadline = std::chrono::steady_clock::now() + std::chrono::seconds(25);
  Media media;
  media.format = avformat_alloc_context(); require(media.format, "Video demuxer allocation failed");
  media.format->interrupt_callback = {interrupted, &request};
  AVDictionary* options = nullptr;
  av_dict_set(&options, "protocol_whitelist", "file", 0);
  int result = avformat_open_input(&media.format, request.path.c_str(), nullptr, &options);
  av_dict_free(&options); ffcheck(result, "Video input could not be opened"); media.opened = true;
  ffcheck(avformat_find_stream_info(media.format, nullptr), "Video stream metadata could not be measured");
  const AVCodec* decoder = nullptr;
  int streamIndex = av_find_best_stream(media.format, AVMEDIA_TYPE_VIDEO, -1, -1, &decoder, 0);
  ffcheck(streamIndex, "Video decoder unavailable for this input"); require(decoder, "Video decoder unavailable for this input");
  AVStream* stream = media.format->streams[streamIndex];
  if (media.format->duration != AV_NOPTS_VALUE && media.format->duration > 0) request.duration = double(media.format->duration) / AV_TIME_BASE;
  else if (stream->duration != AV_NOPTS_VALUE && stream->duration > 0) request.duration = stream->duration * av_q2d(stream->time_base);
  require(std::isfinite(request.duration) && request.duration > 0, "Video duration unavailable");
  media.codec = avcodec_alloc_context3(decoder); require(media.codec, "Video decoder allocation failed");
  ffcheck(avcodec_parameters_to_context(media.codec, stream->codecpar), "Video decoder metadata invalid");
  media.codec->thread_count = 1;
  media.codec->max_pixels = 16384LL * 16384;
  ffcheck(avcodec_open2(media.codec, decoder, nullptr), "Video decoder could not be initialized");
  media.packet = av_packet_alloc(); media.frame = av_frame_alloc(); require(media.packet && media.frame, "Video frame allocation failed");
  bool decoded = false;
  while (!decoded) {
    require(!interrupted(&request), "Video decoding timed out");
    result = av_read_frame(media.format, media.packet);
    if (result < 0) {
      require(result == AVERROR_EOF, "Video packet read failed");
      ffcheck(avcodec_send_packet(media.codec, nullptr), "Video decoder flush failed");
      result = avcodec_receive_frame(media.codec, media.frame);
      ffcheck(result, "No video frame could be decoded"); decoded = true; break;
    }
    if (media.packet->stream_index == streamIndex) {
      result = avcodec_send_packet(media.codec, media.packet);
      require(result >= 0 || result == AVERROR(EAGAIN), "Video packet could not be decoded");
      result = avcodec_receive_frame(media.codec, media.frame);
      if (result == 0) decoded = true;
      else require(result == AVERROR(EAGAIN), "Video frame could not be decoded");
    }
    av_packet_unref(media.packet);
  }
  request.width = media.frame->width; request.height = media.frame->height;
  require(request.width > 0 && request.height > 0 && int64_t(request.width) * request.height <= 16384LL * 16384, "Invalid decoded video dimensions");
  const double ratio = std::min(1.0, 640.0 / std::max(request.width, request.height));
  const int width = std::max(1, int(request.width * ratio)), height = std::max(1, int(request.height * ratio));
  const int stride = (width * 3 + 3) & ~3;
  const uint32_t pixelBytes = uint32_t(stride * height);
  request.image.assign(54 + pixelBytes, 0);
  request.image[0] = 'B'; request.image[1] = 'M';
  le32(request.image, 2, uint32_t(request.image.size())); le32(request.image, 10, 54); le32(request.image, 14, 40);
  le32(request.image, 18, width); le32(request.image, 22, uint32_t(-height)); // top-down, padded BGR24 rows
  le16(request.image, 26, 1); le16(request.image, 28, 24); le32(request.image, 34, pixelBytes);
  media.scale = sws_getContext(request.width, request.height, AVPixelFormat(media.frame->format), width, height, AV_PIX_FMT_BGR24, SWS_BILINEAR, nullptr, nullptr, nullptr);
  require(media.scale, "Video thumbnail scaler allocation failed");
  uint8_t* destinations[4] = {request.image.data() + 54, nullptr, nullptr, nullptr}; int strides[4] = {stride, 0, 0, 0};
  require(sws_scale(media.scale, media.frame->data, media.frame->linesize, 0, request.height, destinations, strides) == height, "Video thumbnail scaling failed");
  require(!interrupted(&request), "Video decoding timed out");
}
void execute(napi_env, void* data) {
  auto& request = *static_cast<Request*>(data);
  try { decode(request); } catch (const std::exception& error) { request.error = error.what(); }
  catch (...) { request.error = "Video decoding failed"; }
}
napi_value text(napi_env env, const char* value) { napi_value result; checked(napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result)); return result; }
void reject(napi_env env, napi_deferred deferred, const char* message) {
  napi_value value; if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &value) != napi_ok) return;
  napi_value error; if (napi_create_error(env, nullptr, value, &error) == napi_ok) napi_reject_deferred(env, deferred, error);
}
void complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Request> request(static_cast<Request*>(data));
  try {
    if (status != napi_ok || !request->error.empty()) reject(env, request->deferred, request->error.empty() ? "Video work cancelled" : request->error.c_str());
    else {
      napi_value result, value; checked(napi_create_object(env, &result));
      checked(napi_create_int32(env, request->width, &value)); checked(napi_set_named_property(env, result, "width", value));
      checked(napi_create_int32(env, request->height, &value)); checked(napi_set_named_property(env, result, "height", value));
      checked(napi_create_double(env, request->duration, &value)); checked(napi_set_named_property(env, result, "duration", value));
      checked(napi_set_named_property(env, result, "format", text(env, "bmp24")));
      checked(napi_create_buffer_copy(env, request->image.size(), request->image.data(), nullptr, &value)); checked(napi_set_named_property(env, result, "image", value));
      checked(napi_resolve_deferred(env, request->deferred, result));
    }
  } catch (const std::exception& error) { reject(env, request->deferred, error.what()); }
  napi_delete_async_work(env, request->work);
}
napi_value getVideoInfo(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value argument; checked(napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr));
    napi_valuetype type; require(argc == 1, "getVideoInfo requires a local file path"); checked(napi_typeof(env, argument, &type)); require(type == napi_string, "Video path must be a string");
    size_t length = 0; checked(napi_get_value_string_utf8(env, argument, nullptr, 0, &length)); require(length > 0 && length <= 32768, "Invalid video path length");
    std::vector<char> buffer(length + 1); size_t copied = 0; checked(napi_get_value_string_utf8(env, argument, buffer.data(), buffer.size(), &copied));
    require(copied == length && std::find(buffer.begin(), buffer.begin()+length, '\0') == buffer.begin()+length, "Invalid video path");
    auto request = std::make_unique<Request>(); request->path.assign(buffer.data(), length);
    napi_value promise; checked(napi_create_promise(env, &request->deferred, &promise));
    napi_status created = napi_create_async_work(env, nullptr, text(env, "QQClientVideoMetadata"), execute, complete, request.get(), &request->work);
    if (created != napi_ok) { reject(env, request->deferred, "Video async work allocation failed"); return promise; }
    if (napi_queue_async_work(env, request->work) != napi_ok) { napi_delete_async_work(env, request->work); reject(env, request->deferred, "Video async work could not be queued"); return promise; }
    request.release(); return promise;
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value initialize(napi_env env, napi_value exports) {
  napi_value function; if (napi_create_function(env, "getVideoInfo", NAPI_AUTO_LENGTH, getVideoInfo, nullptr, &function) != napi_ok || napi_set_named_property(env, exports, "getVideoInfo", function) != napi_ok) return nullptr;
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)

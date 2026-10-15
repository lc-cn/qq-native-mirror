# Packet transport and protocol ownership

The SDK retains independent Node workers, native bundle loading and its existing
login lifecycle. It does not inject a running QQ process or require a QQ host.

`runtime/packet-transport.ts` owns one byte request and response through an
injected `PacketService`. The service is an SDK adapter port, not an assertion
about every binary's native ABI. The two current callers are long-message upload
and forward-resource download; both retain their existing command, input,
protobuf schema and public error policy.

The packet owner captures the method once with its original receiver, copies
request and response bytes, enforces the caller's response size limit, and owns
the timeout, abort subscription and pending cancellation. Closing retires all its
observers. Issued work is never retried and late native rejection remains observed.
Cancellation is rechecked after fallible method and response inspection, including
throwing Proxy traps. Domain decoding checks retirement again before publication.

The normalized response is a plain own-data envelope containing an ordinary
`rspbuffer` Buffer. This is the adapter contract, not a claim that the raw QQ
method supplies that envelope on every platform. The packet owner performs no
protobuf decoding and does not classify server acceptance or recipient visibility.
It is internal and absent from the package root and public client methods.

## Current native evidence and incompatibility

Static inspection of QQ `7.0.2-53644` for macOS arm64, wrapper SHA-256
`fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358`,
found an incompatible binding for `sendSsoCmdReqByContend`:

| Observation                    | Exact static anchor                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Registered method and callback | Literal `0x3a95318`, descriptor `0x5132e68`, callback `0x9cfe10`                                           |
| Positional arguments           | Two generic string converters; the object branch coerces to UTF-8 text rather than extracting Buffer bytes |
| Native dispatch slot           | Receiver virtual slot `0x768`; concrete instance association remains under investigation                   |
| Normal deferred response       | Callback address point `0x5155200`, slot `0x10` to `0xb70d94`; serializer `0xb71088`                       |
| Response shape                 | `result` int32, `errMsg` UTF-8 string and `rsp` UTF-8 string                                               |

Independent byte replay matched 21 complete functions, 2,384 unique bytes, the
registered descriptor, callback pointer and response key. Neither native code nor
an account was executed. The `rsp` string's byte semantics remain unresolved; it
must not be guessed as hex, base64 or a lossless protobuf representation.

A further bounded inspection found candidate address point `0x50ca728`, whose
slot `0x768` targets `0x34a720`. Its request path reaches `0x3612e4` and copies
the supplied string bytes into a vector; the response path at `0x361884` copies
vector bytes into a string. Those copy paths perform no hex/base64 conversion.
The Session installation of this candidate and response closure registration are
still unbound. This adds 13 complete-function checks, without executing either
path. A generic UTF-8 string conversion cannot stand in for a lossless arbitrary
binary protocol codec.

Independent static inspection of Linux arm64 QQ `3.2.32-52194`, wrapper SHA-256
`c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337`,
confirmed the same incompatible carrier in its own registered Msg binding. The
actual Session getter and JavaScript class wrapper preserve that Msg receiver.
The second argument is converted to UTF-8 text, including object-to-string
coercion; it is not read as Buffer bytes. Its per-invocation callback resolves
`result` as int32 and both `errMsg` and `rsp` as UTF-8 strings. The response has
no `rspbuffer` field. An independent reader checked the ELF load segments and
dynamic relocations against the raw bytes; no addon or account was executed.
The sanitized exact-profile record is
[`packet-string-carriers.json`](evidence/packet-string-carriers.json).

The Linux finding establishes the input and normal local response mismatch.
The full network response relay, callback arrival and reversible wire encoding
remain unverified. It does not establish a working SSO or group-member-title
operation. Converting arbitrary protobuf bytes through UTF-8 text can lose data;
neither hex nor base64 is assumed as a replacement.

The composition now rejects the Buffer adapter for these exact measured profiles,
before acquiring its packet service or dispatching the request. Resource reads
report `unsupported-native-contract`; merged-forward upload retains its existing
phase/progress error and reports upload/card as not dispatched. Matching another
version, architecture or hash does not inherit this observed incompatibility or
gain a positive transport admission. Other profiles still need their own proof.

The fixed upstream NapCat usage casts the result to `rspbuffer: Buffer`. That
source usage and controlled SDK tests cannot override the observed binary shape.
Existing signing and real-account proof limits remain unchanged.

## Extending the protocol layer

Before adding a command, prove the selected binary's argument codec, response
codec and request/response association. Implement a binary adapter that yields
owned response bytes and handles the actual native status. Keep protocol request
encoding, response parsing and business errors in the relevant feature domain.
Add it to the exact dependency policy instead of giving all features packet access.

The current reusable transport is verified with controlled service implementations
and the two existing domain consumers. It does not establish real SSO execution,
signature authenticity, universal raw packet support or account safety.

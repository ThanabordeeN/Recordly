// Minimal runtime binding to libinput, used for pointer *button* events.
//
// Why libinput and not raw evdev: on a laptop touchpad a tap produces no
// BTN_LEFT at the kernel level at all -- libinput synthesises the button in
// userspace, which is why KWin sees a click while a raw evdev reader sees
// nothing.  Going through libinput also gives clickfinger mapping (two-finger
// tap = right button) and palm rejection for free, so the helper records
// exactly the buttons the compositor acted on.
//
// libinput is loaded with dlopen rather than linked, so the helper needs no
// libinput-devel at build time and degrades to "button capture unavailable"
// instead of failing to start when the library is absent.  Only opaque
// pointers and frozen public enum values cross this boundary.

#pragma once

#include <cstdint>

// Public, ABI-stable libinput constants.
enum {
	RECORDLY_LI_EVENT_POINTER_BUTTON = 402,
	RECORDLY_LI_BUTTON_STATE_RELEASED = 0,
	RECORDLY_LI_BUTTON_STATE_PRESSED = 1,
	RECORDLY_LI_CONFIG_TAP_DISABLED = 0,
	RECORDLY_LI_CONFIG_TAP_ENABLED = 1,
	RECORDLY_LI_CONFIG_CLICK_METHOD_NONE = 0,
	RECORDLY_LI_CONFIG_CLICK_METHOD_BUTTON_AREAS = 1 << 0,
	RECORDLY_LI_CONFIG_CLICK_METHOD_CLICKFINGER = 1 << 1,
	RECORDLY_LI_CONFIG_TAP_MAP_LRM = 0,
	RECORDLY_LI_CONFIG_TAP_MAP_LMR = 1,
};

struct libinput;
struct libinput_device;
struct libinput_event;
struct libinput_event_pointer;

struct RecordlyLibinputInterface {
	int (*open_restricted)(const char *path, int flags, void *user_data);
	void (*close_restricted)(int fd, void *user_data);
};

struct LibinputApi {
	void *handle = nullptr;

	struct libinput *(*path_create_context)(const struct RecordlyLibinputInterface *, void *) =
		nullptr;
	struct libinput_device *(*path_add_device)(struct libinput *, const char *) = nullptr;
	void (*path_remove_device)(struct libinput_device *) = nullptr;
	struct libinput *(*unref)(struct libinput *) = nullptr;
	int (*get_fd)(struct libinput *) = nullptr;
	int (*dispatch)(struct libinput *) = nullptr;
	struct libinput_event *(*get_event)(struct libinput *) = nullptr;
	void (*event_destroy)(struct libinput_event *) = nullptr;
	int (*event_get_type)(struct libinput_event *) = nullptr;
	struct libinput_event_pointer *(*event_get_pointer_event)(struct libinput_event *) = nullptr;
	uint32_t (*event_pointer_get_button)(struct libinput_event_pointer *) = nullptr;
	int (*event_pointer_get_button_state)(struct libinput_event_pointer *) = nullptr;
	uint64_t (*event_pointer_get_time_usec)(struct libinput_event_pointer *) = nullptr;
	uint32_t (*device_get_id_vendor)(struct libinput_device *) = nullptr;
	uint32_t (*device_get_id_product)(struct libinput_device *) = nullptr;
	const char *(*device_get_name)(struct libinput_device *) = nullptr;
	int (*device_config_tap_get_finger_count)(struct libinput_device *) = nullptr;
	int (*device_config_tap_set_enabled)(struct libinput_device *, int) = nullptr;
	int (*device_config_tap_set_button_map)(struct libinput_device *, int) = nullptr;
	uint32_t (*device_config_click_get_methods)(struct libinput_device *) = nullptr;
	int (*device_config_click_set_method)(struct libinput_device *, int) = nullptr;

	bool load();
	void unload();
};

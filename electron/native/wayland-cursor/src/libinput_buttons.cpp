#include "libinput_buttons.h"

#include <dlfcn.h>

#include <cstdio>

namespace {

template <typename T>
bool bindSymbol(void *handle, const char *name, T &slot) {
	// The double cast is the portable way to turn a void* from dlsym into a
	// function pointer.
	void *symbol = dlsym(handle, name);
	slot = reinterpret_cast<T>(reinterpret_cast<uintptr_t>(symbol));
	return symbol != nullptr;
}

}  // namespace

bool LibinputApi::load() {
	if (handle) {
		return true;
	}

	// soname only: linking against the versioned library keeps the helper
	// working on any distribution that ships libinput, which every Wayland
	// session does by construction.
	handle = dlopen("libinput.so.10", RTLD_LAZY | RTLD_LOCAL);
	if (!handle) {
		return false;
	}

	const bool ok =
		bindSymbol(handle, "libinput_path_create_context", path_create_context) &&
		bindSymbol(handle, "libinput_path_add_device", path_add_device) &&
		bindSymbol(handle, "libinput_path_remove_device", path_remove_device) &&
		bindSymbol(handle, "libinput_unref", unref) &&
		bindSymbol(handle, "libinput_get_fd", get_fd) &&
		bindSymbol(handle, "libinput_dispatch", dispatch) &&
		bindSymbol(handle, "libinput_get_event", get_event) &&
		bindSymbol(handle, "libinput_event_destroy", event_destroy) &&
		bindSymbol(handle, "libinput_event_get_type", event_get_type) &&
		bindSymbol(handle, "libinput_event_get_pointer_event", event_get_pointer_event) &&
		bindSymbol(handle, "libinput_event_pointer_get_button", event_pointer_get_button) &&
		bindSymbol(handle, "libinput_event_pointer_get_button_state",
		           event_pointer_get_button_state) &&
		bindSymbol(handle, "libinput_event_pointer_get_time_usec", event_pointer_get_time_usec) &&
		bindSymbol(handle, "libinput_device_get_id_vendor", device_get_id_vendor) &&
		bindSymbol(handle, "libinput_device_get_id_product", device_get_id_product) &&
		bindSymbol(handle, "libinput_device_get_name", device_get_name) &&
		bindSymbol(handle, "libinput_device_config_tap_get_finger_count",
		           device_config_tap_get_finger_count) &&
		bindSymbol(handle, "libinput_device_config_tap_set_enabled",
		           device_config_tap_set_enabled) &&
		bindSymbol(handle, "libinput_device_config_tap_set_button_map",
		           device_config_tap_set_button_map) &&
		bindSymbol(handle, "libinput_device_config_click_get_methods",
		           device_config_click_get_methods) &&
		bindSymbol(handle, "libinput_device_config_click_set_method",
		           device_config_click_set_method);

	if (!ok) {
		unload();
		return false;
	}

	return true;
}

void LibinputApi::unload() {
	if (handle) {
		dlclose(handle);
		handle = nullptr;
	}
}

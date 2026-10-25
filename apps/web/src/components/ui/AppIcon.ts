/**
 * Draws an icon from Lucide's node data with Vue's element API: no HTML
 * parsing, no `innerHTML`. Unknown names show the given fallback. A
 * custom icon is an `<img>` of its checked `data:` URL; if the
 * browser cannot show it, the built-in icon takes its place.
 */
import { defineComponent, h, ref, watch, type PropType } from "vue";
import {
  BUILTIN_ICON_NODES,
  UI_ICONS,
  type IconNode,
  type UiIcon,
} from "../../icons";

export default defineComponent({
  name: "AppIcon",
  props: {
    /** A built-in name. */
    name: { type: String, default: undefined },
    /** One of the app's control icons. */
    ui: { type: String as PropType<UiIcon>, default: undefined },
    /** `data:image/png` of a custom icon from the core. */
    src: { type: String, default: undefined },
    fallback: { type: String, default: "key-round" },
    size: { type: Number, default: 16 },
  },
  setup(props) {
    const broken = ref(false);
    watch(
      () => props.src,
      () => {
        broken.value = false;
      },
    );
    return () => {
      if (props.src !== undefined && !broken.value)
        return h("img", {
          src: props.src,
          alt: "",
          width: props.size,
          height: props.size,
          class: "icon icon-custom",
          draggable: "false",
          "data-test": "custom-icon",
          onError: () => {
            broken.value = true;
          },
        });
      const node: IconNode =
        (props.ui && UI_ICONS[props.ui]) ||
        (props.name !== undefined
          ? BUILTIN_ICON_NODES.get(props.name)
          : undefined) ||
        BUILTIN_ICON_NODES.get(props.fallback) ||
        [];
      return h(
        "svg",
        {
          xmlns: "http://www.w3.org/2000/svg",
          width: props.size,
          height: props.size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": 2,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
          "aria-hidden": "true",
          focusable: "false",
          class: "icon",
        },
        node.map(([tag, attrs]) => h(tag, attrs)),
      );
    };
  },
});

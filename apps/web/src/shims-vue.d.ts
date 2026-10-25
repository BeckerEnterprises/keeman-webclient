// Lets tools without the Vue language plugin (e.g. typed ESLint rules) resolve
// .vue imports; vue-tsc uses the real component types.
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent;
  export default component;
}

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import router from '@/router';
import PrimeVue from 'primevue/config';
import Aura from '@primevue/themes/aura';
import 'primeicons/resources/primeicons.css';
import App from './App.vue';

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      darkModeSelector: '.dark',
    },
  },
});

app.mount('#app');

import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
    },
    {
      path: '/',
      redirect: '/dashboard',
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/cases/:id',
      name: 'case-detail',
      component: () => import('@/views/CaseDetailView.vue'),
      props: true,
      meta: { requiresAuth: true },
    },
    {
      path: '/review',
      name: 'review',
      component: () => import('@/views/ReviewView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/admin/config',
      name: 'config',
      component: () => import('@/views/ConfigView.vue'),
      meta: { requiresAuth: true, requiresRole: 'admin' },
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
    },
  ],
});

// TODO: implement auth guard
router.beforeEach((to) => {
  if (to.meta.requiresAuth) {
    // TODO: check auth store token and redirect to /login if unauthenticated
  }
});

export default router;

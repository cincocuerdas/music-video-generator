import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { LazyMotion, domAnimation, useReducedMotion, MotionConfig } from 'framer-motion';
import { Toaster } from 'sileo';
import { ThemeProvider } from './contexts/ThemeContext';
import { LanguageProvider } from './contexts/LanguageContext';
import { ErrorBoundary } from './components/ErrorBoundary';

const HomePage = lazy(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })));
const CreateProjectPage = lazy(() =>
  import('./pages/CreateProjectPage').then((m) => ({ default: m.CreateProjectPage })),
);
const ProjectDetailsPage = lazy(() =>
  import('./pages/ProjectDetailsPage').then((m) => ({ default: m.ProjectDetailsPage })),
);
const DirectorPage = lazy(() =>
  import('./pages/DirectorPage').then((m) => ({ default: m.DirectorPage })),
);

function RouteLoader() {
  return (
    <div className="min-h-screen bg-stitch-bg flex items-center justify-center text-gray-400 text-sm">
      Loading...
    </div>
  );
}

function AnimatedRoutes() {
  const location = useLocation();

  return (
    <Routes location={location}>
      <Route
        path="/"
        element={
          <Suspense fallback={<RouteLoader />}>
            <HomePage />
          </Suspense>
        }
      />
      <Route
        path="/create"
        element={
          <Suspense fallback={<RouteLoader />}>
            <CreateProjectPage />
          </Suspense>
        }
      />
      <Route
        path="/project/:id"
        element={
          <Suspense fallback={<RouteLoader />}>
            <ProjectDetailsPage />
          </Suspense>
        }
      />
      <Route
        path="/project/:id/director"
        element={
          <Suspense fallback={<RouteLoader />}>
            <DirectorPage />
          </Suspense>
        }
      />
    </Routes>
  );
}

function App() {
  const prefersReducedMotion = useReducedMotion();
  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion={prefersReducedMotion ? 'always' : 'user'}>
        <ThemeProvider>
          <LanguageProvider>
            <BrowserRouter>
              <ErrorBoundary>
                <AnimatedRoutes />
              </ErrorBoundary>
              <Toaster
                position="top-right"
                options={{
                  duration: 4000,
                }}
              />
            </BrowserRouter>
          </LanguageProvider>
        </ThemeProvider>
      </MotionConfig>
    </LazyMotion>
  );
}

export default App;

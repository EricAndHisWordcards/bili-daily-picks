/** 仪表盘入口：React 根节点 + 渲染错误兜底。 */
import { Component, StrictMode } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './components/App';
import './styles.css';

interface BoundaryState {
  error: Error | null;
}

class RenderErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 方便在扩展页面控制台定位渲染问题
    console.error('[B站每日必看] 仪表盘渲染出错', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="fatal-error" data-testid="error-state" role="alert">
        <h1>仪表盘渲染出错</h1>
        <p>{error.message}</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    );
  }
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <RenderErrorBoundary>
        <App />
      </RenderErrorBoundary>
    </StrictMode>,
  );
}

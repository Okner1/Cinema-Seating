import { Component, type ReactNode } from 'react';
import styled from 'styled-components';

const Wrap = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  font-family: system-ui, sans-serif;
  color: #333;
`;

const Button = styled.button`
  padding: 8px 20px;
  border: none;
  border-radius: 6px;
  background: #2563eb;
  color: #fff;
  font-size: 15px;
  cursor: pointer;

  &:hover {
    background: #1d4ed8;
  }
`;

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('Unhandled render error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Wrap role="alert">
          <h1>Something went wrong</h1>
          <p>An unexpected error occurred. Reloading usually fixes it.</p>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </Wrap>
      );
    }
    return this.props.children;
  }
}

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import styled from 'styled-components';
import { errorMessage } from '../api';
import { useAuth } from '../auth';

const Screen = styled.div`
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
`;

const Card = styled.form`
  width: 100%;
  max-width: 320px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 24px;
  border: 1px solid #d8d8dd;
  border-radius: 10px;
  background: #fff;
`;

const Title = styled.h1`
  margin: 0 0 4px;
  font-size: 20px;
`;

const Input = styled.input`
  padding: 9px 10px;
  font: inherit;
  border: 1px solid #c9c9d1;
  border-radius: 6px;

  &:disabled {
    background: #f4f4f6;
  }
`;

const Buttons = styled.div`
  display: flex;
  gap: 8px;
  margin-top: 4px;
`;

const Button = styled.button<{ $variant?: 'primary' | 'secondary' }>`
  flex: 1;
  padding: 9px 12px;
  font: inherit;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid ${(p) => (p.$variant === 'primary' ? '#2f6df6' : '#c9c9d1')};
  background: ${(p) => (p.$variant === 'primary' ? '#2f6df6' : '#fff')};
  color: ${(p) => (p.$variant === 'primary' ? '#fff' : '#22222a')};

  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
`;

const ErrorText = styled.p`
  margin: 0;
  color: #c0392b;
  font-size: 14px;
`;

export default function LoginPage() {
  const { user, loading, login, register } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Signed in (including right after a successful login/register) → go to the map.
  if (!loading && user !== null) return <Navigate to="/" replace />;

  const run = async (action: (u: string, p: string) => Promise<void>) => {
    setError(null);
    setPending(true);
    try {
      await action(username, password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void run(login);
  };

  return (
    <Screen>
      <Card onSubmit={onSubmit}>
        <Title>Sign in</Title>
        <Input
          name="username"
          placeholder="Username"
          autoComplete="username"
          value={username}
          disabled={pending}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Input
          name="password"
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          disabled={pending}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error !== null && <ErrorText role="alert">{error}</ErrorText>}
        <Buttons>
          <Button type="submit" $variant="primary" disabled={pending}>
            Login
          </Button>
          <Button type="button" disabled={pending} onClick={() => void run(register)}>
            Register
          </Button>
        </Buttons>
      </Card>
    </Screen>
  );
}

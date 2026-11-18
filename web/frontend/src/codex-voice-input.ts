import { useCallback, useEffect, useRef, useState } from 'react';

type VoiceRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

function voiceError(code: string) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '음성 입력을 사용하려면 브라우저에서 마이크 접근을 허용하세요.';
    case 'audio-capture':
      return '사용할 수 있는 마이크를 찾지 못했습니다.';
    case 'no-speech':
      return '음성이 감지되지 않았습니다.';
    case 'network':
      return '브라우저 음성 인식 서비스에 연결하지 못했습니다.';
    case 'language-not-supported':
      return '브라우저에서 현재 언어의 음성 인식을 지원하지 않습니다.';
    default:
      return '음성 인식을 시작하거나 계속할 수 없습니다.';
  }
}

export function useVoiceInput(append: (text: string) => void, report: (message: string) => void) {
  const browser = window as Window & {
    SpeechRecognition?: new () => VoiceRecognition;
    webkitSpeechRecognition?: new () => VoiceRecognition;
  };
  const Recognition = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  const active = useRef<VoiceRecognition | null>(null);
  const [status, setStatus] = useState<'idle' | 'starting' | 'recording' | 'stopping'>('idle');

  const cancel = useCallback(() => {
    const recognition = active.current;
    if (!recognition) return;
    active.current = null;
    recognition.abort();
    setStatus('idle');
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => { if (document.hidden) cancel(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('popstate', cancel);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('popstate', cancel);
      const recognition = active.current;
      active.current = null;
      recognition?.abort();
    };
  }, [cancel]);

  function toggle() {
    if (active.current) {
      if (status === 'starting') {
        cancel();
        return;
      }
      setStatus('stopping');
      active.current.stop();
      return;
    }
    if (!Recognition) {
      report('이 브라우저는 웹 음성 입력을 지원하지 않습니다.');
      return;
    }
    const recognition = new Recognition();
    active.current = recognition;
    recognition.lang = navigator.language;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onstart = () => {
      if (active.current === recognition) setStatus(state => state === 'starting' ? 'recording' : state);
    };
    const finish = () => {
      if (active.current !== recognition) return;
      active.current = null;
      setStatus('idle');
    };
    recognition.onend = finish;
    recognition.onerror = event => {
      if (active.current === recognition && event.error !== 'aborted') report(voiceError(event.error));
      finish();
    };
    recognition.onresult = event => {
      if (active.current !== recognition) return;
      const phrases: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (result.isFinal && result[0].transcript.trim()) phrases.push(result[0].transcript.trim());
      }
      if (phrases.length) append(phrases.join(' '));
    };
    setStatus('starting');
    report('');
    try {
      recognition.start();
    } catch {
      finish();
      report(voiceError('start-failed'));
    }
  }

  return { supported: !!Recognition, status, toggle, cancel };
}

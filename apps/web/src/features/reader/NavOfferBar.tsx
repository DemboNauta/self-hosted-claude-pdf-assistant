import type { LibraryTree } from '@pdfclaudeassistant/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Columns2, CornerDownRight, X } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { t } from '../../i18n';
import { libraryKey } from '../library/api';
import { documentTitle } from './SidePane';
import { useReader } from './store';

const OFFER_MS = 15_000;

/**
 * "Claude te lleva a la p. N · Ir": where Claude wants to take the student while
 * "seguir a Claude" is off (owner's choice: Claude only moves the reader when allowed).
 */
export function NavOfferBar() {
  const offer = useReader((s) => s.offer);
  const docId = useReader((s) => s.docId);
  const currentPage = useReader((s) => s.currentPage);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { setOffer } = useReader.getState();

  // Offers expire, and go away once the student is already there.
  useEffect(() => {
    if (!offer) return;
    const timer = setTimeout(() => {
      if (useReader.getState().offer?.nonce === offer.nonce) setOffer(null);
    }, OFFER_MS);
    return () => clearTimeout(timer);
  }, [offer, setOffer]);
  useEffect(() => {
    if (offer && !offer.side && offer.docId === docId && offer.page === currentPage && !offer.quote)
      setOffer(null);
  }, [offer, docId, currentPage, setOffer]);

  if (!offer) return null;
  const other = offer.docId !== docId;
  const title = other ? documentTitle(qc.getQueryData<LibraryTree>(libraryKey), offer.docId) : null;
  const where = title ? `«${title}», p. ${offer.page}` : `p. ${offer.page}`;
  const wide = window.matchMedia('(min-width: 1024px)').matches;

  const go = () => {
    const reader = useReader.getState();
    setOffer(null);
    if (offer.side && wide) {
      reader.openSide(offer.docId, offer.page);
      return;
    }
    if (!other) {
      reader.goTo(offer.page, offer.quote);
      return;
    }
    const params = new URLSearchParams({ page: String(offer.page) });
    if (offer.quote) params.set('q', offer.quote);
    navigate(`/read/${offer.docId}?${params}`);
  };

  return (
    <div
      role="status"
      className="bg-surface border-border absolute bottom-4 left-1/2 z-20 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-full border py-1 pr-1 pl-3 text-sm shadow-lg"
      data-testid="nav-offer"
    >
      <span className="truncate">
        {offer.side && wide ? t.reader.follow.offerSide(where) : t.reader.follow.offer(where)}
      </span>
      <button
        type="button"
        onClick={go}
        className="flex shrink-0 items-center gap-1 rounded-full bg-orange-600 px-3 py-1 text-xs font-medium text-white hover:bg-orange-700"
      >
        {offer.side && wide ? (
          <Columns2 size={14} aria-hidden />
        ) : (
          <CornerDownRight size={14} aria-hidden />
        )}
        {offer.side && wide ? t.reader.follow.openSide : t.reader.follow.go}
      </button>
      <button
        type="button"
        onClick={() => setOffer(null)}
        aria-label={t.reader.follow.dismiss}
        className="text-text-muted hover:text-text rounded-full p-1"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

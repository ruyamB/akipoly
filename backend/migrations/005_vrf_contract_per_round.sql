-- 005_vrf_contract_per_round: each drawn round records which AkipolyRounds and
-- coordinator answered it, so reviews keep checking the right contract after a
-- redeploy. Rounds drawn before this have nulls; to keep them checkable, set
-- the address they were drawn on, e.g.:
--   update public.rounds set vrf_rounds_address = '0x…', vrf_coordinator = '0x…'
--    where vrf_request_id is not null and vrf_rounds_address is null;
alter table public.rounds add column if not exists vrf_rounds_address text;
alter table public.rounds add column if not exists vrf_coordinator    text;

-- Jobs whose round is no longer drawing (voided) were left 'requested' and
-- polled forever; hold them like voidUndrawnRound now does.
update public.vrf_jobs j
   set status = 'held', last_error = coalesce(j.last_error, 'round voided: no VRF answer before the deadline'),
       updated_at = now()
  from public.rounds r
 where r.id = j.round_id and j.status in ('pending', 'requested') and r.phase <> 'drawing';
